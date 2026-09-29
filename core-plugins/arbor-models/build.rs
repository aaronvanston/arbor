fn main() {
    // The linker names a macOS library by the absolute path it was built at, which would
    // put the build machine's home folder in the release. Arbor also installs one copy per
    // provider, and a shared absolute name can make the loader treat the copies as one.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/libarbor_models.dylib");
    }
}
