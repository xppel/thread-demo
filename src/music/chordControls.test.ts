import {describe,it,expect} from 'vitest';
import {alterChord,CHORD_INTERVALS} from './chordControls';
import type {Chord,Quality} from './types';
const base:Chord={root:0,quality:'maj',symbol:'C',notes:[48,52,55],voicing:{base:[48,52,55],inversion:0}};
describe('held chord controls',()=>{
 it('changes only the third when moving from major to minor',()=>{expect(alterChord(base,'minor').notes).toEqual([48,51,55]);});
 it('adds sevenths and ninths while retaining common held tones',()=>{
  const seven=alterChord(base,'seventh'),nine=alterChord(seven,'ninth');
  expect(seven.symbol).toBe('C7');expect(nine.symbol).toBe('C9');
  expect(nine.notes).toEqual(expect.arrayContaining(base.notes));
  expect(alterChord(nine,'ninth')).toEqual(seven);
  expect(alterChord(alterChord(base,'majorSeventh'),'ninth').symbol).toBe('Cmaj9');
 });
 it('inverts by moving a single voice through an octave',()=>{const up=alterChord(base,'invertUp');expect(up.notes).toEqual([52,55,60]);expect(alterChord(up,'invertDown').notes).toEqual(base.notes);});
 it('keeps every control result valid throughout repeated transformations',()=>{
  let chord=base;
  for(let i=0;i<20;i++)for(const action of ['minor','seventh','ninth','major','majorSeventh','invertUp','invertDown','rootDown','rootUp'] as const){
   chord=alterChord(chord,action);expect(chord.notes.every(n=>n>=0&&n<=127)).toBe(true);
   expect([...new Set(chord.notes.map(n=>(n-chord.root+132)%12))].sort((a,b)=>a-b)).toEqual(CHORD_INTERVALS[chord.quality as Quality].map(n=>n%12).sort((a,b)=>a-b));
  }
 });
});
