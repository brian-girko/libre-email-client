const cache = new Map();

export async function getPref(name, fallback = null) {
  if (cache.has(name)) return cache.get(name);
  const key = 'ui.' + name;
  const stored = await chrome.storage.local.get(key);
  const value = key in stored ? stored[key] : fallback;
  cache.set(name, value);
  return value;
}

export function setPref(name, value) {
  cache.set(name, value);
  const key = 'ui.' + name;
  return value == null
    ? chrome.storage.local.remove(key)
    : chrome.storage.local.set({[key]: value});
}
