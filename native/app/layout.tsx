import type { ReactNode } from "react"
import DiagErrorOverlay from "./_diag-error-overlay"

export const metadata = {
  title: "TuttoHQ",
  description: "TuttoHQ native shell (ADR-010)",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
  (function(){
    function show(label, msg, stack){
      try {
        var pre = document.getElementById('__earlydiag');
        if(!pre){
          pre = document.createElement('pre');
          pre.id='__earlydiag';
          pre.style.cssText='position:fixed;left:0;right:0;bottom:0;max-height:70vh;overflow:auto;margin:0;padding:12px;background:#300;color:#fbb;font:11px monospace;white-space:pre-wrap;z-index:2147483647';
          (document.body||document.documentElement).appendChild(pre);
        }
        pre.textContent += '\\n['+label+'] '+msg+'\\n'+(stack||'')+'\\n';
      } catch(_){}
    }
    window.addEventListener('error', function(e){ show('error', (e&&e.message)||String(e), e&&e.error&&e.error.stack); });
    window.addEventListener('unhandledrejection', function(e){ var r=e&&e.reason; show('reject', (r&&r.message)||String(r), r&&r.stack); });
    window.__earlydiagReady = true;
  })();
`}} />
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#F4F5F7",
          color: "#0F172A",
        }}
      >
        {/* TEMPORARY native-debug error surface — remove after diagnosing. */}
        <DiagErrorOverlay />
        {children}
      </body>
    </html>
  )
}
