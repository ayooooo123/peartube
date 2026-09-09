const runtime = Object.freeze({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  exit(code) {
    process.exitCode = code
  }
})

export default runtime
