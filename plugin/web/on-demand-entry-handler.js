const DynamicEntryPlugin = require('webpack/lib/DynamicEntryPlugin')
const { EventEmitter } = require('events')
const path = require('path')
const { parse } = require('url')
const fs = require('fs')
const promisify = require('next/dist/lib/promisify')
const globModule = require('glob')
const { pageNotFoundError } = require('next-server/dist/server/require')
const { normalizePagePath } = require('next-server/dist/server/normalize-page-path')
const { ROUTE_NAME_REGEX, IS_BUNDLED_PAGE_REGEX } = require('next-server/constants')
const { stringify } = require('querystring')

const ADDED = Symbol('added')
const BUILDING = Symbol('building')
const BUILT = Symbol('built')

const glob = promisify(globModule)
const access = promisify(fs.access)

// Based on https://github.com/webpack/webpack/blob/master/lib/DynamicEntryPlugin.js#L29-L37
function addEntry(compilation, context, name, entry) {
  return new Promise((resolve, reject) => {
    const dep = DynamicEntryPlugin.createDependency(entry, name)
    compilation.addEntry(context, dep, name, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

module.exports = function onDemandEntryHandler(devMiddleware, multiCompiler, {
  buildId,
  dir,
  reload,
  pageExtensions,
  maxInactiveAge,
  pagesBufferLength,
  wsPort
}) {
  const { compilers } = multiCompiler
  const invalidator = new Invalidator(devMiddleware, multiCompiler)
  let entries = {}
  let lastAccessPages = ['']
  let doneCallbacks = new EventEmitter()
  let reloading = false
  let stopped = false
  let reloadCallbacks = new EventEmitter()

  for (const compiler of compilers) {
    compiler.hooks.make.tapPromise('NextJsOnDemandEntries', (compilation) => {
      invalidator.startBuilding()

      const allEntries = Object.keys(entries).map(async (page) => {
        const { name, absolutePagePath } = entries[page]
        try {
          await access(absolutePagePath, (fs.constants || fs).W_OK)
        } catch (err) {
          console.warn('Page was removed', page)
          delete entries[page]
          return
        }

        entries[page].status = BUILDING
        return addEntry(compilation, compiler.context, name, [compiler.name === 'client' ? `next-client-pages-loader?${stringify({ page, absolutePagePath })}!` : absolutePagePath])
      })

      return Promise.all(allEntries)
    })
  }

  multiCompiler.hooks.done.tap('NextJsOnDemandEntries', (multiStats) => {
    const clientStats = multiStats.stats[0]
    const { compilation } = clientStats
    const hardFailedPages = compilation.errors
      .filter(e => {
        // Make sure to only pick errors which marked with missing modules
        const hasNoModuleFoundError = /ENOENT/.test(e.message) || /Module not found/.test(e.message)
        if (!hasNoModuleFoundError) return false

        // The page itself is missing. So this is a failed page.
        if (IS_BUNDLED_PAGE_REGEX.test(e.module.name)) return true

        // No dependencies means this is a top level page.
        // So this is a failed page.
        return e.module.dependencies.length === 0
      })
      .map(e => e.module.chunks)
      .reduce((a, b) => [...a, ...b], [])
      .map(c => {
        const pageName = ROUTE_NAME_REGEX.exec(c.name)[1]
        return normalizePage(`/${pageName}`)
      })

    // compilation.entrypoints is a Map object, so iterating over it 0 is the key and 1 is the value
    for (const [, entrypoint] of compilation.entrypoints.entries()) {
      const result = ROUTE_NAME_REGEX.exec(entrypoint.name)
      if (!result) {
        continue
      }

      const pagePath = result[1]

      if (!pagePath) {
        continue
      }

      const page = normalizePage('/' + pagePath)

      const entry = entries[page]
      if (!entry) {
        continue
      }

      if (entry.status !== BUILDING) {
        continue
      }

      entry.status = BUILT
      entry.lastActiveTime = Date.now()
      doneCallbacks.emit(page)
    }

    invalidator.doneBuilding()

    if (hardFailedPages.length > 0 && !reloading) {
      console.log(`> Reloading webpack due to inconsistant state of pages(s): ${hardFailedPages.join(', ')}`)
      reloading = true
      reload()
        .then(() => {
          console.log('> Webpack reloaded.')
          reloadCallbacks.emit('done')
          stop()
        })
        .catch(err => {
          console.error(`> Webpack reloading failed: ${err.message}`)
          console.error(err.stack)
          process.exit(1)
        })
    }
  })

  const disposeHandler = setInterval(function () {
    if (stopped) return
    disposeInactiveEntries(devMiddleware, entries, lastAccessPages, maxInactiveAge)
  }, 5000)

  disposeHandler.unref()

  function stop() {
    clearInterval(disposeHandler)
    stopped = true
    doneCallbacks = null
    reloadCallbacks = null
  }

  function handlePing(pg, socket) {
    const page = normalizePage(pg)
    const entryInfo = entries[page]

    // If there's no entry.
    // Then it seems like an weird issue.
    if (!entryInfo) {
      const message = `Client pings, but there's no entry for page: ${page}`
      console.error(message)
      return sendJson(socket, { invalid: true })
    }

    // 404 is an on demand entry but when a new page is added we have to refresh the page
    if (page === '/_error') {
      sendJson(socket, { invalid: true })
    } else {
      sendJson(socket, { success: true })
    }

    // We don't need to maintain active state of anything other than BUILT entries
    if (entryInfo.status !== BUILT) return

    // If there's an entryInfo
    if (!lastAccessPages.includes(page)) {
      lastAccessPages.unshift(page)

      // Maintain the buffer max length
      if (lastAccessPages.length > pagesBufferLength) {
        lastAccessPages.pop()
      }
    }
    entryInfo.lastActiveTime = Date.now()
  }

  return {
    waitUntilReloaded() {
      if (!reloading) return Promise.resolve(true)
      return new Promise((resolve) => {
        reloadCallbacks.once('done', function () {
          resolve()
        })
      })
    },

    async ensurePage(page) {
      await this.waitUntilReloaded()
      page = normalizePage(page)
      let normalizedPagePath

      try {
        normalizedPagePath = normalizePagePath(page)
      } catch (err) {
        console.error(err)
        throw pageNotFoundError(normalizedPagePath)
      }

      const extensions = pageExtensions.join('|')
      const pagesDir = path.join(dir, 'pages')

      let modulePagesPaths;
      let modulesDir = global.doodoo ? doodoo.getConf("app.root") : path.resolve("../../", "app");

      let pagesPaths = await glob(`{${normalizedPagePath.slice(1)}/index,${normalizedPagePath.slice(1)}}.+(${extensions})`, { cwd: pagesDir })
      if (pagesPaths.length === 0) {

        let normalizedPagePaths = normalizedPagePath.split("/");
        normalizedPagePaths.splice(2, 0, "view")
        let moduleNormalizedPagePath = normalizedPagePaths.join("/");

        modulePagesPaths = await glob(`{${moduleNormalizedPagePath.slice(1)}/index,${moduleNormalizedPagePath.slice(1)}}.+(${extensions})`, {
          cwd: modulesDir
        });
      }

      // Default the /_error route to the Next.js provided default page
      if (page === '/_error' && pagesPaths.length === 0 && modulePagesPaths.length == 0) {
        pagesPaths = ['next/dist/pages/_error']
      }

      let name, absolutePagePath;
      if (pagesPaths.length) {
        const pagePath = pagesPaths[0]
        let pageUrl = `/${pagePath.replace(new RegExp(`\\.+(${extensions})$`), '').replace(/\\/g, '/')}`.replace(/\/index$/, '')
        pageUrl = pageUrl === '' ? '/' : pageUrl
        const bundleFile = pageUrl === '/' ? '/index.js' : `${pageUrl}.js`

        name = path.join('static', buildId, 'pages', bundleFile)
        absolutePagePath = pagePath.startsWith('next/dist/pages') ? require.resolve(pagePath) : path.join(pagesDir, pagePath)
      } else if (modulePagesPaths.length) {
        const pagePath = modulePagesPaths[0]
        let pageUrl = `/${pagePath.replace(new RegExp(`\\.+(${extensions})$`), '').replace(/\\/g, '/')}`.replace(/\/index$/, '')
        pageUrl = pageUrl === '' ? '/' : pageUrl

        let pageUrls = pageUrl.split("/");
        pageUrls.splice(2, 1);
        pageUrl = pageUrls.join("/")

        let bundleFile = pageUrl === '/' ? '/index.js' : `${pageUrl}.js`

        name = path.join('static', buildId, 'pages', bundleFile)
        absolutePagePath = pagePath.startsWith('next/dist/pages') ? require.resolve(pagePath) : path.resolve(modulesDir, pagePath)
      } else {
        throw pageNotFoundError(normalizedPagePath)
      }

      await new Promise((resolve, reject) => {
        const entryInfo = entries[page]

        if (entryInfo) {
          if (entryInfo.status === BUILT) {
            resolve()
            return
          }

          if (entryInfo.status === BUILDING) {
            doneCallbacks.once(page, handleCallback)
            return
          }
        }

        console.log(`> Building page: ${page}`)

        entries[page] = { name, absolutePagePath, status: ADDED }

        doneCallbacks.once(page, handleCallback)

        invalidator.invalidate()

        function handleCallback(err) {
          if (err) return reject(err)
          resolve()
        }
      })
    },

    wsConnection(ws) {
      ws.onmessage = ({ data }) => {
        // `data` should be the page here
        handlePing(data, ws)
      }
    },

    middleware() {
      return (req, res, next) => {
        if (stopped) {
          // If this handler is stopped, we need to reload the user's browser.
          // So the user could connect to the actually running handler.
          res.statusCode = 302
          res.setHeader('Location', req.url)
          res.end('302')
        } else if (reloading) {
          // Webpack config is reloading. So, we need to wait until it's done and
          // reload user's browser.
          // So the user could connect to the new handler and webpack setup.
          this.waitUntilReloaded()
            .then(() => {
              res.statusCode = 302
              res.setHeader('Location', req.url)
              res.end('302')
            })
        } else {
          if (!/^\/_next\/on-demand-entries-ping/.test(req.url)) return next()

          const { query } = parse(req.url, true)

          if (query.page) {
            return handlePing(query.page, res)
          }

          res.statusCode = 200
          res.setHeader('port', wsPort)
          res.end('200')
        }
      }
    }
  }
}

function disposeInactiveEntries(devMiddleware, entries, lastAccessPages, maxInactiveAge) {
  const disposingPages = []

  Object.keys(entries).forEach((page) => {
    const { lastActiveTime, status } = entries[page]

    // This means this entry is currently building or just added
    // We don't need to dispose those entries.
    if (status !== BUILT) return

    // We should not build the last accessed page even we didn't get any pings
    // Sometimes, it's possible our XHR ping to wait before completing other requests.
    // In that case, we should not dispose the current viewing page
    if (lastAccessPages.includes(page)) return

    if (Date.now() - lastActiveTime > maxInactiveAge) {
      disposingPages.push(page)
    }
  })

  if (disposingPages.length > 0) {
    disposingPages.forEach((page) => {
      delete entries[page]
    })
    console.log(`> Disposing inactive page(s): ${disposingPages.join(', ')}`)
    devMiddleware.invalidate()
  }
}

// /index and / is the same. So, we need to identify both pages as the same.
// This also applies to sub pages as well.
function normalizePage(page) {
  const unixPagePath = page.replace(/\\/g, '/')
  if (unixPagePath === '/index' || unixPagePath === '/') {
    return '/'
  }
  return unixPagePath.replace(/\/index$/, '')
}

function sendJson(socket, data) {
  data = JSON.stringify(data)

  // Handle fetch request
  if (socket.setHeader) {
    socket.setHeader('content-type', 'application/json')
    socket.status = 200
    return socket.end(data)
  }
  // Should be WebSocket so just send
  socket.send(data)
}

// Make sure only one invalidation happens at a time
// Otherwise, webpack hash gets changed and it'll force the client to reload.
class Invalidator {
  constructor(devMiddleware, multiCompiler) {
    this.multiCompiler = multiCompiler
    this.devMiddleware = devMiddleware
    // contains an array of types of compilers currently building
    this.building = false
    this.rebuildAgain = false
  }

  invalidate() {
    // If there's a current build is processing, we won't abort it by invalidating.
    // (If aborted, it'll cause a client side hard reload)
    // But let it to invalidate just after the completion.
    // So, it can re-build the queued pages at once.
    if (this.building) {
      this.rebuildAgain = true
      return
    }

    this.building = true
    // Work around a bug in webpack, calling `invalidate` on Watching.js
    // doesn't trigger the invalid call used to keep track of the `.done` hook on multiCompiler
    for (const compiler of this.multiCompiler.compilers) {
      compiler.hooks.invalid.call()
    }
    this.devMiddleware.invalidate()
  }

  startBuilding() {
    this.building = true
  }

  doneBuilding() {
    this.building = false

    if (this.rebuildAgain) {
      this.rebuildAgain = false
      this.invalidate()
    }
  }
}
