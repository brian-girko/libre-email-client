const tools = {};

tools.view = {
  mode: {
    async get() {
      const {os} = await chrome.runtime.getPlatformInfo();
      if (os === 'android') { // popups are not supported on mobile
        return 'tab';
      }

      const prefs = await chrome.storage.local.get({
        'ui.client.open': 'tab'
      });
      return prefs['ui.client.open'] === 'popup' ? 'popup' : 'tab';
    },
    async apply(mode, update = true) {
      if (mode === 'popup') {
        const prefs = await chrome.storage.local.get({
          'ui.popup.width': 800,
          'ui.popup.height': 600
        });
        const args = new URLSearchParams();
        args.set('width', prefs['ui.popup.width']);
        args.set('height', prefs['ui.popup.height']);

        await chrome.action.setPopup({
          popup: '/data/client/index.html?' + args.toString()
        });
      }
      else {
        await chrome.action.setPopup({
          popup: ''
        });
      }
      if (update) {
        chrome.contextMenus.update('mode.' + mode, {
          checked: true
        });
      }
    }
  }
};

export {tools};
