import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const root=process.cwd(), out=path.join(root,'docs/learning/aegis-message-tour/simulator');
fs.mkdirSync(path.join(out,'core'),{recursive:true});
for(const [src,dest] of [['src/commands.ts','commands'],['src/router.ts','router'],['src/policy.ts','policy'],['src/jev/mock.ts','mock']]) {
  fs.writeFileSync(path.join(out,'core',dest+'.mjs'),ts.transpileModule(fs.readFileSync(src,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
}
const files=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,ent.name);if(ent.isDirectory())walk(f);else if(f.endsWith('.ts'))files.push(f);}}
walk('src');files.push('bin/aegis.mjs','gate.config.json');
const sources=Object.fromEntries(files.map(f=>{const body=fs.readFileSync(f,'utf8');return[f.replaceAll('\\','/'),{body,sha256:crypto.createHash('sha256').update(body).digest('hex')}];}));
fs.writeFileSync(path.join(out,'sources.json'),JSON.stringify({captured:new Date().toISOString(),sources}));
fs.writeFileSync(path.join(out,'config.json'),fs.readFileSync('gate.config.json'));
console.log(`Captured ${files.length} files; compiled four actual pure modules for the browser.`);
