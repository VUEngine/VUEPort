// deliberately does nothing: every workspace has to answer `yarn workspaces run build`, but the installers take minutes
// and a Rust toolchain and nothing else consumes them, so they are built on demand with `yarn bundle`
const bundle = 'yarn workspace vueport-desktop bundle';
console.log(`Nothing to build. The desktop application is bundled on demand: ${bundle}`);
