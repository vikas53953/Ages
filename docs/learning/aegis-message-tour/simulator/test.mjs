import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Simulation,presets,initialFiles,infer,startup} from './engine.mjs';
const config=JSON.parse(fs.readFileSync(new URL('./config.json',import.meta.url)));
let count=0;
for(const p of presets){const options={scenario:p.id,evaluator:['ask','deny'].includes(p.id)?'ask':p.id==='down'?'down':'mock',routing:p.id==='pinned'?'pinned':'auto'};const s=new Simulation(config,p.prompt,options);while(s.pending)s.approve(p.id!=='deny');assert(s.done,p.id);assert(s.events.at(-1).answer,p.id);if(['web','computer'].includes(p.id)){assert.equal(s.records.length,0);assert(s.events.some(e=>e.blocked));}count++;}
const cycle=new Simulation(config,'Read src/math.ts, fix add, then read it again',{scenario:'cycle'});assert.equal(cycle.records.length,3);assert.match(cycle.records[0].output,/a - b/);assert.match(cycle.records[2].output,/a \+ b/);
const deny=new Simulation(config,'Change title',{scenario:'ask',evaluator:'ask'});assert(deny.pending);assert.deepEqual(deny.files,initialFiles());deny.approve(false);assert.deepEqual(deny.files,initialFiles());assert(!deny.events.some(e=>e.node==='execute'));
const yes=new Simulation(config,'Change title',{scenario:'ask',evaluator:'ask'});yes.approve(true);assert.match(yes.files['README.md'],/# Aegis lab/);
const down=new Simulation(config,'Read README.md',{scenario:'read',evaluator:'down'});assert.equal(down.route.model,config.frontierModel);assert(!down.events.some(e=>e.node==='execute'));assert.match(down.output,/denied/);
for(const id of ['outside','duplicate','missing','shell']){const s=new Simulation(config,'demo',{scenario:id});assert(s.records[0].failed,id);assert.deepEqual(s.files,initialFiles());}
const slash=new Simulation(config,'/help');assert(!slash.events.some(e=>e.node==='model'));assert.equal(infer('search the internet'),'web');assert.equal(infer('click a button'),'computer');
const cancel=new Simulation(config,'change title',{scenario:'ask',evaluator:'ask'});cancel.cancelAt(2);assert(cancel.cancelled);assert(!cancel.pending);assert.deepEqual(cancel.files,initialFiles());assert.equal(startup().length,5);
const snapshot=JSON.parse(fs.readFileSync(new URL('./sources.json',import.meta.url)));
const referenceEvents=[...startup(),...cancel.events];
for(const p of presets){const s=new Simulation(config,p.prompt,{scenario:p.id,evaluator:['ask','deny'].includes(p.id)?'ask':p.id==='down'?'down':'mock',routing:p.id==='pinned'?'pinned':'auto'});if(s.pending)s.approve(true);referenceEvents.push(...s.events);}
for(const e of referenceEvents)assert(snapshot.sources[e.source.file]?.body.includes(e.source.needle),`Missing code reference: ${JSON.stringify(e.source)}`);
console.log(`PASS: ${count} presets; approve/deny, read-edit-read, unavailable Jev, failures, slash bypass, cancellation and capability boundaries.`);
