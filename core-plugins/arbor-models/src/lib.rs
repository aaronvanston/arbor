//! The core loads this library from its `plugins/` folder and talks to it through
//! the CLIProxyAPI plugin ABI: one `call` entry point that takes a method name and a
//! JSON request and hands back a JSON envelope. Everything the plugin decides lives
//! in `registry`, so it can be tested without the ABI.

mod registry;

use std::ffi::{c_char, c_void, CStr};
use std::ptr;

const ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct CliproxyBuffer {
    ptr: *mut u8,
    len: usize,
}

type HostCall =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type HostFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginCall = unsafe extern "C" fn(*const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type PluginFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginShutdown = unsafe extern "C" fn();

#[repr(C)]
pub struct CliproxyHostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<HostCall>,
    free_buffer: Option<HostFree>,
}

#[repr(C)]
pub struct CliproxyPluginApi {
    abi_version: u32,
    call: Option<PluginCall>,
    free_buffer: Option<PluginFree>,
    shutdown: Option<PluginShutdown>,
}

/// # Safety
/// Called once by the core with a valid, writable `plugin` table.
#[no_mangle]
pub unsafe extern "C" fn cliproxy_plugin_init(
    _host: *const CliproxyHostApi,
    plugin: *mut CliproxyPluginApi,
) -> i32 {
    if plugin.is_null() {
        return 1;
    }
    (*plugin).abi_version = ABI_VERSION;
    (*plugin).call = Some(plugin_call);
    (*plugin).free_buffer = Some(plugin_free);
    (*plugin).shutdown = Some(plugin_shutdown);
    0
}

unsafe extern "C" fn plugin_call(
    method: *const c_char,
    request: *const u8,
    request_len: usize,
    response: *mut CliproxyBuffer,
) -> i32 {
    if response.is_null() {
        return 1;
    }
    (*response).ptr = ptr::null_mut();
    (*response).len = 0;
    let method = if method.is_null() {
        ""
    } else {
        CStr::from_ptr(method).to_str().unwrap_or("")
    };
    let request = if request.is_null() || request_len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(request, request_len)
    };
    // A panic must never unwind into the core's Go runtime.
    let envelope = std::panic::catch_unwind(|| registry::handle(method, request))
        .unwrap_or_else(|_| registry::error_envelope("plugin_panic", "arbor-models panicked"));
    write_response(response, envelope);
    0
}

unsafe extern "C" fn plugin_free(ptr: *mut c_void, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(ptr.cast::<u8>(), len)));
    }
}

unsafe extern "C" fn plugin_shutdown() {}

unsafe fn write_response(response: *mut CliproxyBuffer, text: String) {
    let bytes = text.into_bytes().into_boxed_slice();
    let len = bytes.len();
    (*response).ptr = Box::into_raw(bytes).cast::<u8>();
    (*response).len = len;
}
