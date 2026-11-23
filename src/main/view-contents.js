// Electron can leave a WebContentsView attached after its page is destroyed.
function liveContents(view) {
  const contents = view?.webContents;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

module.exports = { liveContents };
