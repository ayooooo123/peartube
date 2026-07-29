// Every name the relay reads through `#fs`. A name missing here is not a
// compile error anywhere — it arrives as `undefined` and the caller quietly
// degrades, which is how the storage guard's free-disk floor spent this whole
// project measuring nothing on a Bare relay while its tests passed on Node.
export {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'bare-fs'
