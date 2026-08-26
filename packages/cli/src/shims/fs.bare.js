// Every name the relay reads through `#fs`. A name missing here is not a
// compile error anywhere — it arrives as `undefined` and the caller quietly
// degrades, which is how the storage guard's free-disk floor spent this whole
// project measuring nothing on a Bare relay while its tests passed on Node.
export {
  closeSync,
  chmodSync,
  createReadStream,
  fsyncSync,
  existsSync,
  mkdirSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'bare-fs'
