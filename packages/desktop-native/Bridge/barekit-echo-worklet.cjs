const { IPC } = BareKit

IPC.on('data', (data) => {
  IPC.write(data)
})

setInterval(() => {}, 1 << 30)
