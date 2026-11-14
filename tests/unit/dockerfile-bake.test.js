const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const service = fs.readFileSync(path.join(repoRoot, 'src', 'rust_test_service.js'), 'utf8');

// ---------------------------------------------------------------------------
// The runtime namespace has ZERO internet egress. Every crate the scaffolded
// Cargo.toml names has to be baked into the image already, or /execute fails at
// resolution. The bake and the generator are two copies of the same list, in two
// languages, in two files — exactly the shape that rots silently. Pin them.
//
// The bake used to live in a separate `Dockerfile.base`; the public repository
// folds that image into the `toolchain` stage of this one Dockerfile. The
// invariant did not change, only which file owns it — so the guard FOLLOWED it
// rather than being deleted with the split.
// ---------------------------------------------------------------------------
describe('the baked crate cache matches what the service scaffolds', () => {
    // Parsed out of the [dev-dependencies] block the service writes into every
    // generated Cargo.toml.
    const devDepBlock = service.slice(service.indexOf('[dev-dependencies]'));
    const generated = [...devDepBlock.matchAll(/^(\w[\w-]*) = "([\d.]+)"$/gm)]
        .slice(0, 3)
        .map(([, name, version]) => ({ name, version }));

    test('the generator really declares dev-dependencies (guards a vacuous parse)', () => {
        expect(generated.length).toBe(3);
        expect(generated.map((d) => d.name).sort()).toEqual(['criterion', 'proptest', 'tokio-test']);
    });

    test.each(generated)('the image bakes $name $version', ({ name, version }) => {
        expect(dockerfile).toContain(`${name} = "${version}"`);
    });

    test('the bake compiles, it does not merely fetch', () => {
        // `cargo fetch` succeeds against an index that is missing a crate body.
        // Compiling once is what proves the cache is actually complete.
        expect(dockerfile).toContain('cargo fetch');
        expect(dockerfile).toMatch(/cargo test --offline/);
    });

    test('CARGO_NET_OFFLINE is set', () => {
        // Measured: without it cargo ignores the populated cache, tries to update
        // the crates.io index, and dies on DNS. With it the same project is green.
        expect(dockerfile).toMatch(/^ENV CARGO_NET_OFFLINE=true$/m);
    });
});

// ---------------------------------------------------------------------------
// The bake is only in the shipped image if the app stage BUILDS ON the stage
// that performs it. Without these, someone could point the app at
// `library/rust` again and every assertion above would still pass while the
// pushed image silently lost the crate cache — a failure that would only appear
// at /execute, in a namespace with no egress to explain it.
// ---------------------------------------------------------------------------
describe('the shipped stage consumes the stage that bakes', () => {
    test('the toolchain stage starts from the public upstream image', () => {
        expect(dockerfile).toMatch(
            /^FROM docker\.io\/library\/rust:\$\{RUST_TOOLCHAIN\}-slim-bookworm AS toolchain$/m
        );
    });

    test('the app stage is built FROM the toolchain stage', () => {
        expect(dockerfile).toMatch(/^FROM toolchain AS app$/m);
    });

    test('nothing in the build reaches a private registry', () => {
        // A public repository must build from public artefacts only.
        expect(dockerfile).not.toMatch(/registry\.internal|BASE_REGISTRY/);
    });
});
