const Buffer = require('safe-buffer').Buffer
const binarySearchInsert = require('binary-search-insert')

// decides which message to go first
function messageArbiter (messageA, messageB) {
  // order by number of ticks if messages have different number of ticks
  if (messageA._fromTicks !== messageB._fromTicks) {
    return messageA._fromTicks > messageB._fromTicks
  } else {
    // sender id
    return Buffer.compare(messageA._fromId, messageB._fromId)
  }
}

module.exports = class Inbox {
  /**
   * The inbox manages and sorts incoming messages and provides functions
   * to wait on messages
   * @param {Object} opts
   * @param {Object} opts.state
   * @param {Object} opts.hypervisor
   */
  constructor (opts) {
    this.actor = opts.actor
    this.hypervisor = opts.hypervisor
    this._queue = []
    this._waitingTagsQueue = []
    this._oldestMessagePromise = new Promise((resolve, reject) => {
      this._oldestMessageResolve = resolve
    })
  }

  /**
   * queues a message
   * @param {Message} message
   */
  queue (message) {
    this._queueMessage(message)

    const oldestMessage = this._getOldestMessage()
    if (oldestMessage === message) {
      this._oldestMessageResolve(message)
      this._oldestMessagePromise = new Promise((resolve, reject) => {
        this._oldestMessageResolve = resolve
      })
    }
  }

  /**
   * Waits for a message sent with a capablitly that has one of the given tags
   * @param {Array<*>} tags
   * @param {Integer} timeout
   * @returns {Promise}
   */
  async nextTaggedMessage (tags, timeout) {
    this._waitingTags = new Set(tags)
    this._queue = this._queue.filter(message => !this._queueTaggedMessage(message))

    // todo: add saturation test
    const message = await this.nextMessage(timeout)
    delete this._waitingTags
    this._waitingTagsQueue.forEach(message => this._queueMessage(message))
    this._waitingTagsQueue = []

    return message
  }

  /**
   * Waits for the the next message if any
   * @param {Integer} timeout
   * @returns {Promise}
   */
  nextMessage (timeout, getCurrent = false) {
    if (!this._gettingNextMessage) {
      this._gettingNextMessage = this._nextMessage(timeout)
      this._gettingNextMessage.then(() => {
        this._gettingNextMessage = false
      })
    } else if (!getCurrent) {
      throw new Error('already waiting for next message')
    }
    return this._gettingNextMessage
  }

  async _nextMessage (timeout) {
    let message = this._getOldestMessage()
    if (message === undefined && timeout === 0) {
      return
    }

    timeout += this.actor.ticks
    let oldestTime = this.hypervisor.scheduler.leastNumberOfTicks(this.actor.id)

    while (true) {
      if (message) {
        // if the message we recived had more ticks then we currently have then
        // update our ticks to it, since we jumped forward in time
        if (message._fromTicks > this.actor.ticks) {
          this.actor.ticks = message._fromTicks
          this.hypervisor.scheduler.update(this.actor)
        }

        // if there is a message that is "older" then the timeout, the lower
        // the timeout to the oldest message
        if (message._fromTicks < timeout) {
          timeout = message._fromTicks
        }
      }

      // if all actors are "older" then the time out then stop waiting for messages
      // since we konw that we can not receive one
      if (oldestTime >= timeout) {
        break
      }

      await Promise.race([
        this.hypervisor.scheduler.wait(timeout, this.actor.id).then(() => {
          message = this._getOldestMessage()
        }),
        this._olderMessage(message).then(m => {
          message = m
        })
      ])
      oldestTime = this.hypervisor.scheduler.leastNumberOfTicks(this.actor.id)
    }
    return this._deQueueMessage()
  }

  // returns a promise that resolve when a message older then the given message
  // is recived
  _olderMessage (message) {
    return this._oldestMessagePromise
  }

  _getOldestMessage () {
    if (this._waitingTags) {
      return this._waitingTagsQueue[0]
    } else {
      return this._queue[0]
    }
  }

  _deQueueMessage () {
    if (this._waitingTags) {
      return this._waitingTagsQueue.shift()
    } else {
      return this._queue.shift()
    }
  }

  _queueMessage (message) {
    if (!(this._waitingTags && this._queueTaggedMessage(message))) {
      binarySearchInsert(this._queue, messageArbiter, message)
    }
  }

  _queueTaggedMessage (message) {
    if (this._waitingTags.has(message.tag)) {
      this._waitingTags.delete(message.tag)
      binarySearchInsert(this._waitingTagsQueue, messageArbiter, message)
      return true
    } else {
      return false
    }
  }
}
