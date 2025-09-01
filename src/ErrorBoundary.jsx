// ErrorBoundary.jsx
import React from "react";
export default class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){
    try {
      console.error('[ErrorBoundary]', err, info);
      const el = document.getElementById('__panic_overlay__');
      if (el) {
        const pre = document.createElement('pre');
        pre.textContent = '[React] ' + (err?.stack || err?.message || String(err));
        el.appendChild(pre);
      }
    } catch {}
  }
  render(){
    if (this.state.err) {
      return (
        <div style={{padding:16}}>
          <h3>Algo deu errado</h3>
          <pre style={{whiteSpace:'pre-wrap'}}>{String(this.state.err?.message || this.state.err)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
