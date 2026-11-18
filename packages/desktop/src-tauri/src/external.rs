// links leaving the app (caught in web/src/desktop-external.ts) open in the system browser, as the webviews drop
// target="_blank" and following one in place would replace the emulator. Only http(s) passes, never file:// or another
// app's scheme, since URLs come from Planet VB's API and the network

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    // not a parser: whitespace or a control character means something trying to be two arguments
    let allowed = url.starts_with("https://") || url.starts_with("http://");
    if !allowed || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{url} is not a web address VUEPort will open."));
    }

    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|error| format!("{url} could not be opened: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // only the refusals are checked, as the other half opens a browser
    #[test]
    fn only_a_web_address_is_opened() {
        for refused in [
            "file:///etc/passwd",
            "smb://somewhere/share",
            "vueport://x",
            "javascript:alert(1)",
            "",
            // a second argument disguised as a URL
            "https://example.com\nopen /Applications/Calculator.app",
            "https://example.com /Applications/Calculator.app",
            " https://example.com",
        ] {
            assert!(
                open_external(refused.to_string()).is_err(),
                "{refused} should not be opened"
            );
        }
    }
}
