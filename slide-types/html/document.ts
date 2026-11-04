// Builds the sandboxed document for an HTML slide. The server serves it with
// the returned CSP as a header; srcdoc is not used because it would inherit
// the player's (strict) CSP.
import { fillPlaceholders, type PlaceholderContext } from '@foyer/slide-sdk/runtime';
import type { SlideDocument } from '@foyer/slide-sdk';
import type { HtmlConfig } from './index.ts';

// Injected into every HTML slide (ES5, < 2 KB). Exposes window.foyer and maps
// the player's lifecycle messages onto classes on <html>, so pure-CSS slides
// can start animations with `.foyer-active .x { animation: … }`.
export const RUNTIME = `(function(){
var root=document.documentElement,handlers={prepare:[],start:[],stop:[]};
function post(type,detail){try{parent.postMessage({foyer:type,detail:detail},'*');}catch(e){}}
function setPhase(phase){
  root.classList.remove('foyer-prepared');root.classList.remove('foyer-active');
  if(phase==='prepare')root.classList.add('foyer-prepared');
  if(phase==='start')root.classList.add('foyer-active');
  var list=handlers[phase]||[];
  for(var i=0;i<list.length;i++){try{list[i]();}catch(e){post('error',String(e&&e.message||e));}}
}
window.foyer={
  onPrepare:function(fn){handlers.prepare.push(fn);},
  onStart:function(fn){handlers.start.push(fn);},
  onStop:function(fn){handlers.stop.push(fn);},
  done:function(){post('done');},
  error:function(message){post('error',String(message));}
};
window.addEventListener('message',function(event){
  var data=event.data;
  if(data&&typeof data.foyer==='string'&&handlers[data.foyer])setPhase(data.foyer);
});
window.addEventListener('error',function(event){post('error',String(event.message));});
post('ready');
})();`;

export function parseVariables(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

// A literal "</script" inside user code would end the inline script early.
function scriptSafe(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

function styleSafe(code: string): string {
  return code.replace(/<\/style/gi, '<\\/style');
}

export function buildCsp(allowExternal: boolean): string {
  const external = allowExternal ? ' https:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob:${external}`,
    `media-src data: blob:${external}`,
    `font-src data:${external}`,
    `style-src 'unsafe-inline'${external}`,
    `script-src 'unsafe-inline'${external}`,
    // No network access for scripts unless external resources are allowed.
    `connect-src${external || " 'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function buildDocument(config: HtmlConfig, ctx: PlaceholderContext): SlideDocument {
  const values = { ...parseVariables(config.variables), ...(ctx.values ?? {}) };
  const html = fillPlaceholders(config.html, { ...ctx, values });
  return {
    csp: buildCsp(config.allowExternal),
    html: `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
<style>${styleSafe(config.css)}</style>
<script>${RUNTIME}</script>
</head><body>${html}<script>${scriptSafe(config.js)}</script></body></html>`,
  };
}
