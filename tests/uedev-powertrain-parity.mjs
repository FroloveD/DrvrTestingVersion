// Сравнение продольных функций C++ с текущими TS, без Unreal SDK.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(), 'uedev-parity-'));
try {
  const bundle = join(temp, 'vehicle.mjs');
  execFileSync(resolve('node_modules/.bin/esbuild'), ['src/sim/vehicle.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=error']);
  const ts = await import(pathToFileURL(bundle).href);
  const checks = [];
  const add = (expression, expected) => checks.push(`check(${expression}, ${expected.toPrecision(17)});`);
  for (const mode of [-1, 0, 1, 2, 3, 4, 5, 6]) {
    const gear = mode === -1 ? 'R' : mode === 0 ? 'N' : String(mode);
    for (const speed of [-2, 0, 0.1, 2, 8, 16, 30, 49.9]) {
      for (const th of [0, 0.2, 0.6, 1]) for (const running of [false, true]) {
        const args = `${th},${mode},${speed},${running}`;
        for (const shift of [0, 0.2]) {
          add(`uedev::EngineAccel(${args},false,${shift})`, ts.computeEngineAccel(th,gear,Math.max(1,mode),speed,running,false,shift));
          add(`uedev::EngineRpm(4200,${args},${shift},0.4,false,1.0/60)`,
            ts.stepEngineRpm(4200,th,gear,Math.max(1,mode),speed,running,shift,1/60,0.4,false));
        }
        add(`uedev::RoadDrag(${Math.abs(speed)},${th},${mode},${running})`,
          ts.computeRoadDragDecel(Math.abs(speed),th,Math.max(0,mode),gear,running));
      }
    }
  }
  for (const speed of [0,0.2,1,10,30,50]) for (const brake of [0,0.1,0.5,1]) for (const boost of [false,true]) {
    add(`uedev::ServiceBrake(${brake},${speed},${boost})`, ts.computeServiceBrakeDecel(brake,speed,boost?1:0));
    add(`uedev::Creep(${speed},0.1,${brake},true)`, ts.computeIdleCreepAccel('D',1,speed,0.1,brake,true,false));
  }
  writeFileSync(join(temp, 'parity.cpp'), `#include "Powertrain.h"
#include <cstdlib>
#include <iostream>
void check(double value, double expected) {
 if (std::abs(value-expected)>1e-9) { std::cerr << value << " != " << expected << '\\n'; std::exit(1); }
}
int main() { ${checks.join('\n')} }
`);
  const binary = join(temp, 'parity');
  execFileSync(process.env.CXX || 'g++', ['-std=c++17','-Wall','-Wextra','-Werror','-pedantic','-I',resolve('ue/UEDev/Source/UEDev/Public'),join(temp,'parity.cpp'),'-o',binary]);
  execFileSync(binary, [], {stdio:'inherit'});
  console.log(`PASS UEDev powertrain TS/C++: ${checks.length} comparisons, tolerance 1e-9`);
} finally { rmSync(temp, {recursive:true,force:true}); }
