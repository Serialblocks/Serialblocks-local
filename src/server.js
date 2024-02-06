import { Server } from 'socket.io'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import https from 'node:https'
import ip from 'ip'
import chalk from 'chalk'
import 'dotenv/config'
import { isJSON } from './lib/utils.js'
const PORT = process.env.PORT || 8080
const ipAddress = ip.address()
const httpServer = https.createServer()
const io = new Server(httpServer)
io.listen(PORT)

console.log(`local ip address: ${ipAddress}/${PORT}`)

io.on('connection', (socket) => {
  console.log(socket.handshake.auth)
  const { DisplayName, delimiter, EOL, ...serialPortConfig } =
    socket.handshake.auth

  const SERIALPORT = new SerialPort({
    ...serialPortConfig,
    autoOpen: false
  })
    .on('error', (err) => {
      // The error provides an error object whenever there is an unhandled error.
      // usually an error is handled with a callback to the method that produced it.
      // except the write method as it may or may not be called with the error as its first argument.
      socket.emit('portError', err, SERIALPORT.path)
      console.error(chalk.red('port err with reason:' + err))
    })

    .on('close', (err) => {
      if (err?.disconnected === true) {
        socket.emit('suddenPortDisc', err?.message, SERIALPORT.path)
        // BROADCAST sudden disconnection
        socket.broadcast.emit('notifyClients', {
          action: 'suddenPortDisc',
          path: SERIALPORT.path,
          DisplayName,
          err: err?.message
        })
      }
    })

  // reading from Port
  const parser = SERIALPORT.pipe(new ReadlineParser({ delimiter }))
  parser.on('data', (data) => {
    console.log(chalk.greenBright(data))
    if (isJSON(data)) {
      const parsedData = JSON.parse(data)
      for (const key of Object.keys(parsedData)) {
        parsedData[key] = {
          value:
            typeof parsedData[key] === 'object' &&
            Object.hasOwn(parsedData[key], 'value')
              ? parsedData[key].value
              : parsedData[key],
          interval: parsedData[key]?.interval,
          timestamp: Date.now()
        }
      }
      socket.emit('parsedData', JSON.stringify(parsedData))
    }
    socket.emit('rawData', data)
  })

  socket
    .on('listPorts', async (cb) => {
      // TODO: add isFetching state (no need?)
      const serialPorts = await SerialPort.list()
      cb(serialPorts)
    })

    .on('openPort', (cb) => {
      // client requested to open Port
      if (!SERIALPORT.isOpen) {
        SERIALPORT.open((arg) => {
          // arg is either an Error object or null
          // null indicates a successful connection
          // while an Error object (message, name and stack[optional]) indicates a problem with opening the port.
          // 1) port isn't connected to server (file not found)
          // 2) port is already connected/unavailable (access is denied)
          // BROADCAST opening port
          socket.broadcast.emit('notifyClients', {
            action: 'openPort',
            path: SERIALPORT.path,
            DisplayName
          })
          cb({ errorMsg: arg?.message || null, path: SERIALPORT.path })
        })
      }
    })

    .on('writeToPort', (command) => {
      if (SERIALPORT.isOpen) {
        // If a port is disconnected during a write, the write will error in addition to the close event.
        // the callback may or may not be called with the error as its first argument.
        // To reliably detect write errors, add a listener for the 'error' event.
        SERIALPORT.write(command.trim() + EOL, 'utf8') // trim() remove any \r \n, whitespace.
      }
    })

    .on('closePort', (cb) => {
      // client requested to disconnect Port
      if (SERIALPORT.isOpen) {
        // If there are in-progress writes when the port is closed the writes will error.
        // @param callback — Called once a connection is closed.
        SERIALPORT.close(() => {
          cb(SERIALPORT.path)
          // BROADCAST client disconnection
          socket.broadcast.emit('notifyClients', {
            action: 'closePort',
            path: SERIALPORT.path,
            DisplayName
          })
        })
      }
    })
})
