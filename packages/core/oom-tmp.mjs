import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
for (let k=0;k<3;k++){
const mem = new WebAssembly.Memory({ initial: 256, maximum: 1280 });
const qjs = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: mem }));
const rt=qjs.newRuntime(); rt.setMemoryLimit(64*1024*1024); const ctx=rt.newContext();
const r=ctx.evalCode(['const a=[]; while(true) a.push({x:Math.random()})','const a=[]; while(true) a.push([1,2,3])','let s="a"; while(true) s+=s.slice(0,1000)+Math.random()'][k]);
console.log(JSON.stringify(r.error?ctx.dump(r.error):'ok'), typeof (r.error&&ctx.dump(r.error)));
try{(r.error||r.value).dispose(); ctx.dispose(); rt.dispose();}catch(e){console.log('dispose threw',e.message)}
}
