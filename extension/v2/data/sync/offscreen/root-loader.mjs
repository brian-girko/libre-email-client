// root-loader.mjs — resolve hook for plain `node` runs of the sync engine's
// tests: snapshot.mjs imports the bundled parser by the extension-absolute
// path '/core/parser/postal-mime.mjs', which the browser import map grounds
// at the extension root — under node it is grounded at this repo's root.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/')) {
    return next(new URL('../../..' + specifier, import.meta.url).href, context);
  }
  return next(specifier, context);
}
