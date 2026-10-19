// Runs before the bundled OHIF application starts. This child frame can only
// forward requests to its same-origin parent, which owns the SHLink session.
(() => {
  const base = new URL('../', document.currentScript.src), params = new URLSearchParams(location.search);
  const session = params.get('shlSession');
  if (!/^[a-f0-9-]{36}$/.test(session || '')) throw new Error('Open OHIF from the SHLink demo page');
  const root = new URL(`dicomweb/${session}/`, base).href.replace(/\/$/, '');
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.protocol === 'shlink-dicomweb-v1' && event.data.session === session && event.ports[0]) parent.postMessage(event.data, location.origin, [event.ports[0]]);
  });
  window.config = {
    routerBasename: new URL('ohif-viewer/', base).pathname.replace(/\/$/, ''),
    showStudyList: false, extensions: [], modes: [], defaultDataSourceName: 'shlink',
    showWarningMessageForCrossOrigin: false, showCPUFallbackMessage: false,
    showLoadingIndicator: true, maxNumberOfWebWorkers: 2,
    dataSources: [{ namespace: '@ohif/extension-default.dataSourcesModule.dicomweb', sourceName: 'shlink', configuration: {
      friendlyName: 'SMART Health Link', name: 'shlink', qidoRoot: root, wadoRoot: root, wadoUriRoot: root,
      qidoSupportsIncludeField: false, supportsFuzzyMatching: false, supportsWildcard: true,
      imageRendering: 'wadors', thumbnailRendering: 'wadors', enableStudyLazyLoad: true,
      staticWado: true, singlepart: 'bulkdata,video,pdf', dicomUploadEnabled: false,
      acceptHeader: ['multipart/related; type=application/octet-stream; transfer-syntax=*'],
      bulkDataURI: { enabled: true },
    } }],
  };
})();
