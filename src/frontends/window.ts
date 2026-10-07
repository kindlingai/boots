// `ai-bootstrap --gui-window URL TITLE`: the GUI's native window, in a process
// of its own because a webview blocks the event loop while it runs. It only
// shows the page the main process serves; closing it ends the session.
// The webview library (WebKitGTK on Linux, WebKit on macOS, WebView2 on
// Windows) is fetched on first use; if it cannot load, this exits non-zero
// and the main process opens the page in a browser instead.

export async function windowMain(url: string, title: string): Promise<number> {
  try {
    const { Webview, SizeHint } = await import("@webview/webview");
    const w = new Webview(false, { width: 1000, height: 760, hint: SizeHint.NONE });
    w.title = title;
    w.navigate(url);
    w.run();
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /webkitgtk/i.test(msg)
      ? " (install WebKitGTK 6.0: libwebkitgtk-6.0-4 on Debian/Ubuntu, webkitgtk6.0 on Fedora)"
      : "";
    console.error(`cannot open a window: ${msg}${hint}`);
    return 1;
  }
}
