// Runs bare-pack under Bare (`bare mobile/pack.cjs <bare-pack args>`): its
// module lexer addon segfaults under Node 22. bare-pack's CLI reads the global
// `process`, which Bare only has once bare-process/global is loaded.
require('bare-process/global')
require('../node_modules/bare-pack/bin.js')
