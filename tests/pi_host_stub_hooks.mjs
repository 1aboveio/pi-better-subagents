/**
 * Module resolve hook for extension-level tests: redirect the pi host-provided
 * `@earendil-works/pi-ai` package (present at runtime inside pi, NOT installed
 * in this repo) to a local stub. This stubs an EXTERNAL package boundary only;
 * no first-party module is intercepted. Registered by
 * tests/extension_health_lifecycle.test.mjs via `module.register()`.
 */
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") {
        return { url: new URL("./pi_host_package_stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
