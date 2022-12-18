/**
 * @license
 * Copyright (c) 2021, 2022, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl.
 */
'use strict';

define(['utils/k8s-domain-actions-base', 'models/wkt-project', 'models/wkt-console', 'utils/i18n', 'utils/project-io',
  'utils/dialog-helper', 'utils/k8s-domain-resource-generator', 'utils/k8s-domain-configmap-generator',
  'utils/validation-helper', 'utils/helm-helper', 'utils/wkt-logger'],
function (K8sDomainActionsBase, project, wktConsole, i18n, projectIo, dialogHelper, K8sDomainResourceGenerator,
  K8sDomainConfigMapGenerator, validationHelper) {
  class K8sDomainStatusChecker extends K8sDomainActionsBase {
    constructor() {
      super();
    }

    async startCheckDomainStatus() {
      await this.executeAction(this.callCheckDomainStatus);
    }

    async callCheckDomainStatus() {
      let errTitle = i18n.t('k8s-domain-status-checker-get-status-failed-title-message');
      let errPrefix = 'k8s-domain-status-checker';
      const validatableObject = this.getValidatableObject('flow-get-domain-status-name');
      if (validatableObject.hasValidationErrors()) {
        const validationErrorDialogConfig = validatableObject.getValidationErrorDialogConfig(errTitle);
        dialogHelper.openDialog('validation-error-dialog', validationErrorDialogConfig);
        return Promise.resolve(false);
      }

      const totalSteps = 7.0;
      try {
        const kubectlExe = this.getKubectlExe();
        const kubectlOptions = this.getKubectlOptions();
        const kubectlContext = this.getKubectlContext();
        let operatorMajorVersion = '';

        let busyDialogMessage = i18n.t('flow-validate-kubectl-exe-in-progress');
        dialogHelper.openBusyDialog(busyDialogMessage, 'bar');
        dialogHelper.updateBusyDialog(busyDialogMessage, 0 / totalSteps);
        if (! await this.validateKubectlExe(kubectlExe, errTitle, errPrefix)) {
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-save-project-in-progress');
        dialogHelper.updateBusyDialog(busyDialogMessage, 1 / totalSteps);
        if (! await this.saveProject(errTitle, errPrefix)) {
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-kubectl-use-context-in-progress');
        dialogHelper.updateBusyDialog(busyDialogMessage, 2 / totalSteps);
        if (!await this.useKubectlContext(kubectlExe, kubectlOptions, kubectlContext, errTitle, errPrefix)) {
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-validate-k8s-namespace-in-progress',
          {namespace: this.project.k8sDomain.kubernetesNamespace.value});
        dialogHelper.updateBusyDialog(busyDialogMessage, 3 / totalSteps);

        const nsStatus = await this.validateKubernetesNamespaceExists(kubectlExe, kubectlOptions,
          this.project.k8sDomain.kubernetesNamespace.value, errTitle, errPrefix);
        if (!nsStatus) {
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-validate-k8s-domain-in-progress', {domain: this.project.k8sDomain.uid.value});
        dialogHelper.updateBusyDialog(busyDialogMessage, 4 / totalSteps);
        if (! await this.validateDomainExists(kubectlExe, kubectlOptions, errTitle, errPrefix)) {
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-getting-k8s-domain-status-in-progress', {domain: this.project.k8sDomain.uid.value});
        dialogHelper.updateBusyDialog(busyDialogMessage, 5 / totalSteps);

        const domainStatusResult = await window.api.ipc.invoke('k8s-get-wko-domain-status', kubectlExe,
          this.project.k8sDomain.uid.value, this.project.k8sDomain.kubernetesNamespace.value, kubectlOptions);
        if (!domainStatusResult.isSuccess) {
          const errMessage = i18n.t('k8s-domain-status-checker-get-status-failed-error-message',
            {error: domainStatusResult.reason});
          dialogHelper.closeBusyDialog();
          await window.api.ipc.invoke('show-error-message', errTitle, errMessage);
          return Promise.resolve(false);
        }

        busyDialogMessage = i18n.t('flow-checking-operator-version-in-progress');
        dialogHelper.updateBusyDialog(busyDialogMessage, 6 / totalSteps);

        const operatorVersionResult = await window.api.ipc.invoke('k8s-get-operator-version-from-domain-config-map',
          kubectlExe, this.project.k8sDomain.kubernetesNamespace.value, kubectlOptions);
        if (operatorVersionResult.isSuccess) {
          operatorMajorVersion = operatorVersionResult.operatorVersion.split('.')[0];
        }

        dialogHelper.closeBusyDialog();

        let wkoDomainStatus = domainStatusResult.domainStatus;
        if (typeof wkoDomainStatus === 'undefined') {
          wkoDomainStatus = {};
        }
        const results = this.buildDomainStatus(wkoDomainStatus, operatorMajorVersion);
        results['domainStatus'] = wkoDomainStatus;
        const options = {domainStatus: results.domainStatus, domainOverallStatus: results.domainOverallStatus};
        dialogHelper.openDialog('domain-status-dialog', options);

        return Promise.resolve(true);
      } catch (err) {
        dialogHelper.closeBusyDialog();
        throw err;
      } finally {
        dialogHelper.closeBusyDialog();
      }
    }

    getValidatableObject(flowNameKey) {
      const validationObject = validationHelper.createValidatableObject(flowNameKey);

      validationObject.addField('domain-design-uid-label', this.project.k8sDomain.uid.validate(true));
      validationObject.addField('domain-design-namespace-label',
        this.project.k8sDomain.kubernetesNamespace.validate(true));

      const kubectlFormConfig = validationObject.getDefaultConfigObject();
      kubectlFormConfig.formName = 'kubectl-title';
      validationObject.addField('kubectl-exe-file-path-label',
        validationHelper.validateRequiredField(this.project.kubectl.executableFilePath.value), kubectlFormConfig);
      validationObject.addField('kubectl-helm-exe-file-path-label',
        validationHelper.validateRequiredField(this.project.kubectl.helmExecutableFilePath.value), kubectlFormConfig);

      const settingsFormConfig = validationObject.getDefaultConfigObject();
      settingsFormConfig.formName = 'project-settings-title';
      validationObject.addField('image-design-image-tag-label',
        this.project.image.imageTag.validate(true), settingsFormConfig);

      return validationObject;
    }
  }

  return new K8sDomainStatusChecker();
});
