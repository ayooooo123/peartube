const { IPC } = BareKit

IPC.on('data', (data) => {
  IPC.write(data)
})

await new Promise(() => {})
