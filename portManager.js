const BN = require('bn.js')
const Message = require('primea-message')

// decides which message to go first
function messageArbiter (nameA, nameB) {
  const a = this.ports[nameA].messages[0]
  const b = this.ports[nameB].messages[0]

  if (!a) {
    return nameB
  } else if (!b) {
    return nameA
  }

  // order by number of ticks if messages have different number of ticks
  if (a._fromTicks !== b._fromTicks) {
    return a._fromTicks < b._fromTicks ? nameA : nameB
  } else {
    // insertion order
    return nameA
  }
}

module.exports = class PortManager {
  /**
   * The port manager manages the the ports. This inculdes creation, deletion
   * fetching and waiting on ports
   * @param {Object} opts
   * @param {Object} opts.state
   * @param {Object} opts.entryPort
   * @param {Object} opts.parentPort
   * @param {Object} opts.hypervisor
   * @param {Object} opts.exoInterface
   */
  constructor (opts) {
    Object.assign(this, opts)
    this.ports = this.state.ports
    this._unboundPorts = new Set()
    this._waitingPorts = {}
    this._saturationPromise = new Promise((resolve, reject) => {
      this._saturationResolve = resolve
    })
    this._oldestMessagePromise = new Promise((resolve, reject) => {
      this._oldestMessageResolve = resolve
    })
  }

  /**
   * binds a port to a name
   * @param {Object} port - the port to bind
   * @param {String} name - the name of the port
   */
  async bind (name, port) {
    if (this.isBound(port)) {
      throw new Error('cannot bind a port that is already bound')
    } else if (this.ports[name]) {
      throw new Error('cannot bind port to a name that is alread bound')
    } else {
      this._unboundPorts.delete(port)
      this.hypervisor.removeNodeToCheck(this.id)

      // save the port instance
      this.ports[name] = port

      // update the dest port
      const destPort = await this.hypervisor.getDestPort(port)
      destPort.destName = name
      destPort.destId = this.id
      delete destPort.destPort
    }
  }

  /**
   * unbinds a port given its name
   * @param {string} name
   * @returns {Promise}
   */
  async unbind (name) {
    const port = this.ports[name]
    delete this.ports[name]
    this._unboundPorts.add(port)

    // update the destination port
    const destPort = await this.hypervisor.getDestPort(port)
    delete destPort.destName
    delete destPort.destId
    destPort.destPort = port
    this.hypervisor.addNodeToCheck(this.id)
    return port
  }

  /**
   * delete an port given the name it is bound to
   * @param {string} name
   */
  delete (name) {
    const port = this.ports[name]
    this.exInterface.send(port, new Message({
      data: 'delete'
    }))
    this._delete(name)
  }

  _delete (name) {
    this.hypervisor.addNodeToCheck(this.id)
    delete this.ports[name]
  }

  /**
   * clears any unbounded ports referances
   */
  clearUnboundedPorts () {
    this._unboundPorts.forEach(port => {
      this.exInterface.send(port, new Message({
        data: 'delete'
      }))
    })
    this._unboundPorts.clear()
    if (Object.keys(this.ports).length === 0) {
      this.hypervisor.deleteInstance(this.id)
    }
  }

  /**
   * check if a port object is still valid
   * @param {Object} port
   * @return {Boolean}
   */
  isBound (port) {
    return !this._unboundPorts.has(port)
  }

  /**
   * queues a message on a port
   * @param {Message} message
   */
  queue (name, message) {
    if (name) {
      const port = this.ports[name]
      if (port.messages.push(message) === 1 && message._fromTicks < this._messageTickThreshold) {
        message._fromPort = port
        message.fromName = name
        this._oldestMessageResolve(message)
        this._oldestMessagePromise = new Promise((resolve, reject) => {
          this._oldestMessageResolve = resolve
        })
        this._messageTickThreshold = Infinity
      }
    }
    if (this.isSaturated()) {
      this._saturationResolve()
      this._saturationPromise = new Promise((resolve, reject) => {
        this._saturationResolve = resolve
      })
    }
  }

  /**
   * gets a port given it's name
   * @param {String} name
   * @return {Object}
   */
  get (name) {
    return this.ports[name]
  }

  /**
   * creates a new container. Returning a port to it.
   * @param {String} type
   * @param {*} data - the data to populate the initail state with
   * @returns {Object}
   */
  create (type, data) {
    let nonce = this.state.nonce

    const id = {
      nonce: nonce,
      parent: this.id
    }

    // incerment the nonce
    nonce = new BN(nonce)
    nonce.iaddn(1)
    this.state.nonce = nonce.toArray()

    // create a new channel for the container
    const ports = this.createChannel()
    this._unboundPorts.delete(ports[1])
    this.hypervisor.createInstance(type, data, [ports[1]], id)

    return ports[0]
  }

  /**
   * creates a channel returns the created ports in an Array
   * @returns {array}
   */
  createChannel () {
    const port1 = {
      messages: []
    }

    const port2 = {
      messages: [],
      destPort: port1
    }

    port1.destPort = port2
    this._unboundPorts.add(port1)
    this._unboundPorts.add(port2)
    return [port1, port2]
  }

  /**
   * find and returns the next message
   * @returns {object}
   */
  peekNextMessage () {
    const names = Object.keys(this.ports)
    if (names.length) {
      const portName = names.reduce(messageArbiter.bind(this))
      const port = this.ports[portName]
      const message = port.messages[0]

      if (message) {
        message._fromPort = port
        message.fromName = portName
        return message
      }
    }
  }

  /**
   * tests wether or not all the ports have a message
   * @returns {boolean}
   */
  isSaturated () {
    const keys = Object.keys(this.ports)
    return keys.length ? keys.every(name => this.ports[name].messages.length) : 0
  }

  whenSaturated () {
    return this._saturationPromise
  }

  olderMessage (message) {
    this._messageTickThreshold = message ? message._fromTicks : 0
    return this._oldestMessagePromise
  }
}
