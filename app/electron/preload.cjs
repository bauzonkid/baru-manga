const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    search: (pluginId, query) => ipcRenderer.invoke('plugins:search', { pluginId, query }),
    openLocal: pluginId => ipcRenderer.invoke('plugins:openLocal', { pluginId }),
    getManga: (pluginId, id) => ipcRenderer.invoke('plugins:getManga', { pluginId, id }),
    getChapters: (pluginId, mangaId, opts) =>
      ipcRenderer.invoke('plugins:getChapters', { pluginId, mangaId, opts }),
    getPages: (pluginId, chapterId) =>
      ipcRenderer.invoke('plugins:getPages', { pluginId, chapterId }),
    openByUrl: url => ipcRenderer.invoke('plugins:openByUrl', { url }),
    openUserFolder: () => ipcRenderer.invoke('plugins:openUserFolder')
  },
  image: {
    fetch: (url, referer) => ipcRenderer.invoke('image:fetch', { url, referer })
  },
  chapter: {
    registerReferer: (pageUrls, referer) =>
      ipcRenderer.invoke('chapter:registerReferer', { pageUrls, referer }),
    download: opts => ipcRenderer.invoke('chapter:download', opts),
    readLocalAsBase64: paths => ipcRenderer.invoke('chapter:readLocalAsBase64', { paths }),
    splitPanels: (workspaceId, chapterSlug, opts, mode) => ipcRenderer.invoke('chapter:splitPanels', { workspaceId, chapterSlug, opts, mode }),
    onSplitProgress: cb => {
      const handler = (_e, info) => cb(info)
      ipcRenderer.on('chapter:splitPanels:progress', handler)
      return () => ipcRenderer.removeListener('chapter:splitPanels:progress', handler)
    },
    openDownloadsFolder: ({ workspaceId, mangaSlug } = {}) =>
      ipcRenderer.invoke('chapter:openDownloadsFolder', { workspaceId, mangaSlug }),
    onDownloadProgress: cb => {
      const handler = (_e, info) => cb(info)
      ipcRenderer.on('chapter:download:progress', handler)
      return () => ipcRenderer.removeListener('chapter:download:progress', handler)
    }
  },
  ai: {
    ping: () => ipcRenderer.invoke('ai:ping'),
    listModels: () => ipcRenderer.invoke('ai:listModels'),
    review: opts => ipcRenderer.invoke('ai:review', opts),
    voiceoverScript: opts => ipcRenderer.invoke('ai:voiceoverScript', opts)
  },
  tts: {
    meta: () => ipcRenderer.invoke('tts:meta'),
    speak: opts => ipcRenderer.invoke('tts:speak', opts),
    speakBatch: opts => ipcRenderer.invoke('tts:speakBatch', opts),
    cacheStats: () => ipcRenderer.invoke('tts:cacheStats'),
    cacheClear: () => ipcRenderer.invoke('tts:cacheClear'),
    onBatchProgress: cb => {
      const handler = (_e, info) => cb(info)
      ipcRenderer.on('tts:speakBatch:progress', handler)
      return () => ipcRenderer.removeListener('tts:speakBatch:progress', handler)
    }
  },
  video: {
    render: opts => ipcRenderer.invoke('video:render', opts),
    renderBatch: opts => ipcRenderer.invoke('video:renderBatch', opts),
    overlaySubtitle: opts => ipcRenderer.invoke('video:overlaySubtitle', opts),
    openFolder: videoPath => ipcRenderer.invoke('video:openFolder', { videoPath }),
    onProgress: cb => {
      const handler = (_e, info) => cb(info)
      ipcRenderer.on('video:render:progress', handler)
      return () => ipcRenderer.removeListener('video:render:progress', handler)
    }
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    setKey: key => ipcRenderer.invoke('license:setKey', { key }),
    clear: () => ipcRenderer.invoke('license:clear'),
    deviceId: () => ipcRenderer.invoke('license:deviceId')
  },
  workspace: {
    list: () => ipcRenderer.invoke('workspace:list'),
    get: id => ipcRenderer.invoke('workspace:get', { id }),
    create: input => ipcRenderer.invoke('workspace:create', input),
    update: (id, patch) => ipcRenderer.invoke('workspace:update', { id, patch }),
    delete: id => ipcRenderer.invoke('workspace:delete', { id }),
    upsertChapter: (workspaceId, chapter) => ipcRenderer.invoke('workspace:upsertChapter', { workspaceId, chapter }),
    removeChapter: (workspaceId, chapterId) => ipcRenderer.invoke('workspace:removeChapter', { workspaceId, chapterId }),
    scanPages: (workspaceId, chapters) => ipcRenderer.invoke('workspace:scanPages', { workspaceId, chapters }),
    scanRenders: (workspaceId) => ipcRenderer.invoke('workspace:scanRenders', { workspaceId }),
    saveSegments: (workspaceId, chapterSlug, segments) => ipcRenderer.invoke('workspace:saveSegments', { workspaceId, chapterSlug, segments }),
    loadSegments: (workspaceId, chapters) => ipcRenderer.invoke('workspace:loadSegments', { workspaceId, chapters })
  }
})
