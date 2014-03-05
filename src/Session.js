(function (SIP) {

// Load dependencies
var DTMF            = @@include('../src/Session/DTMF.js')

var Session, InviteServerContext, InviteClientContext,
 C = {
    //Session states
    STATUS_NULL:                        0,
    STATUS_INVITE_SENT:                 1,
    STATUS_1XX_RECEIVED:                2,
    STATUS_INVITE_RECEIVED:             3,
    STATUS_WAITING_FOR_ANSWER:          4,
    STATUS_ANSWERED:                    5,
    STATUS_WAITING_FOR_PRACK:           6,
    STATUS_WAITING_FOR_ACK:             7,
    STATUS_CANCELED:                    8,
    STATUS_TERMINATED:                  9,
    STATUS_ANSWERED_WAITING_FOR_PRACK: 10,
    STATUS_EARLY_MEDIA:                11,
    STATUS_CONFIRMED:                  12
  };

/*
 * @param {function returning SIP.MediaHandler} [mediaHandlerFactory]
 *        (See the documentation for the mediaHandlerFactory argument of the UA constructor.)
 */
Session = function (mediaHandlerFactory) {
  var events = [
  'connecting',
  'terminated',
  'dtmf',
  'invite',
  'cancel',
  'referred',
  'bye',
  'hold',
  'unhold',
  'muted',
  'unmuted'
  ];

  this.status = C.STATUS_NULL;
  this.dialog = null;
  this.earlyDialogs = {};
  this.mediaHandlerFactory = mediaHandlerFactory || SIP.WebRTC.MediaHandler.defaultFactory;
  // this.mediaHandler gets set by ICC/ISC constructors
  this.hasOffer = false;
  this.hasAnswer = false;

  // Session Timers
  this.timers = {
    ackTimer: null,
    expiresTimer: null,
    invite2xxTimer: null,
    userNoAnswerTimer: null,
    rel1xxTimer: null,
    prackTimer: null
  };

  // Session info
  this.startTime = null;
  this.endTime = null;
  this.tones = null;

  // Mute/Hold state
  this.local_hold = false;
  this.remote_hold = false;

  this.pending_actions = {
    actions: [],

    length: function() {
      return this.actions.length;
    },

    isPending: function(name){
      var
      idx = 0,
      length = this.actions.length;

      for (idx; idx<length; idx++) {
        if (this.actions[idx].name === name) {
          return true;
        }
      }
      return false;
    },

    shift: function() {
      return this.actions.shift();
    },

    push: function(name) {
      this.actions.push({
        name: name
      });
    },

    pop: function(name) {
      var
      idx = 0,
      length = this.actions.length;

      for (idx; idx<length; idx++) {
        if (this.actions[idx].name === name) {
          this.actions.splice(idx,1);
          length --;
          idx--;
        }
      }
    }
   };

  this.early_sdp = null;
  this.rel100 = SIP.C.supported.UNSUPPORTED;

  this.initMoreEvents(events);
};

Session.prototype = {
  dtmf: function(tones, options) {
    var duration, interToneGap,
      position = 0,
      self = this;

    options = options || {};
    duration = options.duration || null;
    interToneGap = options.interToneGap || null;

    if (tones === undefined) {
      throw new TypeError('Not enough arguments');
    }

    // Check Session Status
    if (this.status !== C.STATUS_CONFIRMED && this.status !== C.STATUS_WAITING_FOR_ACK) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    // Check tones
    if (!tones || (typeof tones !== 'string' && typeof tones !== 'number') || !tones.toString().match(/^[0-9A-D#*,]+$/i)) {
      throw new TypeError('Invalid tones: '+ tones);
    }

    tones = tones.toString();

    // Check duration
    if (duration && !SIP.Utils.isDecimal(duration)) {
      throw new TypeError('Invalid tone duration: '+ duration);
    } else if (!duration) {
      duration = DTMF.C.DEFAULT_DURATION;
    } else if (duration < DTMF.C.MIN_DURATION) {
      this.logger.warn('"duration" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_DURATION+ ' milliseconds');
      duration = DTMF.C.MIN_DURATION;
    } else if (duration > DTMF.C.MAX_DURATION) {
      this.logger.warn('"duration" value is greater than the maximum allowed, setting it to '+ DTMF.C.MAX_DURATION +' milliseconds');
      duration = DTMF.C.MAX_DURATION;
    } else {
      duration = Math.abs(duration);
    }
    options.duration = duration;

    // Check interToneGap
    if (interToneGap && !SIP.Utils.isDecimal(interToneGap)) {
      throw new TypeError('Invalid interToneGap: '+ interToneGap);
    } else if (!interToneGap) {
      interToneGap = DTMF.C.DEFAULT_INTER_TONE_GAP;
    } else if (interToneGap < DTMF.C.MIN_INTER_TONE_GAP) {
      this.logger.warn('"interToneGap" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_INTER_TONE_GAP +' milliseconds');
      interToneGap = DTMF.C.MIN_INTER_TONE_GAP;
    } else {
      interToneGap = Math.abs(interToneGap);
    }

    if (this.tones) {
      // Tones are already queued, just add to the queue
      this.tones += tones;
      return this;
    }

    // New set of tones to start sending
    this.tones = tones;

    var sendDTMF = function () {
      var tone, timeout,
      tones = self.tones;

      if (self.status === C.STATUS_TERMINATED || !tones || position >= tones.length) {
        // Stop sending DTMF
        self.tones = null;
        return this;
      }

      tone = tones[position];
      position += 1;

      if (tone === ',') {
        timeout = 2000;
      } else {
        var dtmf = new DTMF(self);
        dtmf.on('failed', function(){self.tones = null;});
        dtmf.send(tone, options);
        timeout = duration + interToneGap;
      }

      // Set timeout for the next tone
      window.setTimeout(sendDTMF, timeout);
    };

    // Send the first tone
    sendDTMF();
    return this;
  },

  bye: function(options) {
    options = options || {};
    var statusCode = options.statusCode;

    // Check Session Status
    if (this.status === C.STATUS_TERMINATED) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    this.logger.log('terminating RTCSession');

    if (statusCode && (statusCode < 200 || statusCode >= 700)) {
      throw new TypeError('Invalid statusCode: '+ statusCode);
    }

    options.receiveResponse = function () {};

    return this.
      sendRequest(SIP.C.BYE, options).
      terminated();
  },

  refer: function(target, options) {
    options = options || {};
    var extraHeaders = options.extraHeaders || [], originalTarget;
    
    if (target === undefined) {
      throw new TypeError('Not enough arguments');
    } else if (target instanceof SIP.InviteServerContext || target instanceof SIP.InviteClientContext) {
      //Attended Transfer
      // B.transfer(C)
      extraHeaders.push('Contact: '+ this.contact);
      extraHeaders.push('Allow: '+ SIP.Utils.getAllowedMethods(this.ua));
      extraHeaders.push('Refer-To: <' + target.dialog.remote_target.toString() + '?Replaces=' + target.dialog.id.call_id + '%3Bto-tag%3D' + target.dialog.id.remote_tag + '%3Bfrom-tag%3D' + target.dialog.id.local_tag + '>');
    } else {
      //Blind Transfer

      // Check Session Status
      if (this.status !== C.STATUS_CONFIRMED) {
        throw new SIP.Exceptions.InvalidStateError(this.status);
      }

      // Check target validity
      target = this.ua.normalizeTarget(target);
      if (!target) {
        throw new TypeError('Invalid target: ' + originalTarget);
      }

      extraHeaders.push('Contact: '+ this.contact);
      extraHeaders.push('Allow: '+ SIP.Utils.getAllowedMethods(this.ua));
      extraHeaders.push('Refer-To: '+ target);
    }

    // Send the request
    return this.
      sendRequest(SIP.C.REFER, {
        extraHeaders: extraHeaders,
        body: options.body
      }).
      terminate();
  },

  sendRequest: function(method,options) {
    options = options || {};
    var self = this;
    var request = new SIP.OutgoingRequest(
      method,
      this.dialog.remote_target,
      this.ua,
      {
        cseq: options.cseq || (this.dialog.local_seqnum += 1),
        call_id: this.dialog.id.call_id,
        from_uri: this.dialog.local_uri,
        from_tag: this.dialog.id.local_tag,
        to_uri: this.dialog.remote_uri,
        to_tag: this.dialog.id.remote_tag,
        route_set: this.dialog.route_set,
        statusCode: options.statusCode,
        reasonPhrase: options.reasonPhrase
      },
      options.extraHeaders || [],
      options.body
    );

    new SIP.RequestSender({
      request: request,
      onRequestTimeout: function() {
        self.onRequestTimeout();
      },
      onTransportError: function() {
        self.onTransportError();
      },
      receiveResponse: options.receiveResponse || function(response) {
        self.receiveNonInviteResponse(response);
      }
    }, this.ua).send();

    // Emit the request event
    if (this.checkEvent(method.toLowerCase())) {
      this.emit(method.toLowerCase(), request);
    }

    return this;
  },

  close: function() {
    var idx;

    if(this.status === C.STATUS_TERMINATED) {
      return this;
    }

    this.logger.log('closing INVITE session ' + this.id);

    // 1st Step. Terminate media.
    if (this.mediaHandler){
      this.mediaHandler.close();
    }

    // 2nd Step. Terminate signaling.

    // Clear session timers
    for(idx in this.timers) {
      window.clearTimeout(this.timers[idx]);
    }

    // Terminate dialogs

    // Terminate confirmed dialog
    if(this.dialog) {
      this.dialog.terminate();
      delete this.dialog;
    }

    // Terminate early dialogs
    for(idx in this.earlyDialogs) {
      this.earlyDialogs[idx].terminate();
      delete this.earlyDialogs[idx];
    }

    this.status = C.STATUS_TERMINATED;

    delete this.ua.sessions[this.id];
    return this;
  },

  createDialog: function(message, type, early) {
    var dialog, early_dialog,
      local_tag = message[(type === 'UAS') ? 'to_tag' : 'from_tag'],
      remote_tag = message[(type === 'UAS') ? 'from_tag' : 'to_tag'],
      id = message.call_id + local_tag + remote_tag;

    early_dialog = this.earlyDialogs[id];

    // Early Dialog
    if (early) {
      if (early_dialog) {
        return true;
      } else {
        early_dialog = new SIP.Dialog(this, message, type, SIP.Dialog.C.STATUS_EARLY);

        // Dialog has been successfully created.
        if(early_dialog.error) {
          this.logger.error(early_dialog.error);
          this.failed(message, SIP.C.causes.INTERNAL_ERROR);
          return false;
        } else {
          this.earlyDialogs[id] = early_dialog;
          return true;
        }
      }
    }
    // Confirmed Dialog
    else {
      // In case the dialog is in _early_ state, update it
      if (early_dialog) {
        early_dialog.update(message, type);
        this.dialog = early_dialog;
        delete this.earlyDialogs[id];
        for (var dia in this.earlyDialogs) {
          this.earlyDialogs[dia].terminate();
          delete this.earlyDialogs[dia];
        }
        return true;
      }

      // Otherwise, create a _confirmed_ dialog
      dialog = new SIP.Dialog(this, message, type);

      if(dialog.error) {
        this.logger.error(dialog.error);
        this.failed(message, SIP.C.causes.INTERNAL_ERROR);
        return false;
      } else {
        this.to_tag = message.to_tag;
        this.dialog = dialog;
        return true;
      }
    }
  },

  /**
  * Check if Session is ready for a re-INVITE
  *
  * @returns {Boolean}
  */
  isReadyToReinvite: function() {
    return this.mediaHandler.isReady() &&
      !this.dialog.uac_pending_reply &&
      !this.dialog.uas_pending_reply;
  },

  /**
   * Mute
   */
  mute: function(options) {
    var ret = this.mediaHandler.mute(options);
    if (ret) {
      this.onmute(ret);
    }
  },

  /**
   * Unmute
   */
  unmute: function(options) {
    options = options || {};
    options.local_hold = this.local_hold;
    var ret = this.mediaHandler.unmute(options);
    if (ret) {
      this.onunmute(ret);
    }
  },

  /**
   * Hold
   */
  hold: function() {

    if (this.status !== C.STATUS_WAITING_FOR_ACK && this.status !== C.STATUS_CONFIRMED) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    this.mediaHandler.hold();

    // Check if RTCSession is ready to send a reINVITE
    if (!this.isReadyToReinvite()) {
      /* If there is a pending 'unhold' action, cancel it and don't queue this one
       * Else, if there isn't any 'hold' action, add this one to the queue
       * Else, if there is already a 'hold' action, skip
       */
      if (this.pending_actions.isPending('unhold')) {
        this.pending_actions.pop('unhold');
      } else if (!this.pending_actions.isPending('hold')) {
        this.pending_actions.push('hold');
      }
      return;
    } else if (this.local_hold === true) {
        return;
    }

    this.onhold('local');

    this.sendReinvite({
      mangle: function(body){

        // Don't receive media
        // TODO - This will break for media streams with different directions.
        if (!(/a=(sendrecv|sendonly|recvonly|inactive)/).test(body)) {
          body = body.replace(/(m=[^\r]*\r\n)/g, '$1a=sendonly\r\n');
        } else {
          body = body.replace(/a=sendrecv\r\n/g, 'a=sendonly');
          body = body.replace(/a=recvonly\r\n/g, 'a=inactive');
        }

        return body;
      }
    });
  },

  /**
   * Unhold
   */
  unhold: function() {

    if (this.status !== C.STATUS_WAITING_FOR_ACK && this.status !== C.STATUS_CONFIRMED) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    this.mediaHandler.unhold();

    if (!this.isReadyToReinvite()) {
      /* If there is a pending 'hold' action, cancel it and don't queue this one
       * Else, if there isn't any 'unhold' action, add this one to the queue
       * Else, if there is already a 'unhold' action, skip
       */
      if (this.pending_actions.isPending('hold')) {
        this.pending_actions.pop('hold');
      } else if (!this.pending_actions.isPending('unhold')) {
        this.pending_actions.push('unhold');
      }
      return;
    } else if (this.local_hold === false) {
      return;
    }

    this.onunhold('local');

    this.sendReinvite();
  },

  /**
   * isOnHold
   */
  isOnHold: function() {
    return {
      local: this.local_hold,
      remote: this.remote_hold
    };
  },

  /**
   * In dialog INVITE Reception
   * @private
   */
  receiveReinvite: function(request) {
    var self = this,
        contentType = request.getHeader('Content-Type'),
        hold = true;

    if (request.body) {
      if (contentType !== 'application/sdp') {
        this.logger.warn('invalid Content-Type');
        request.reply(415);
        return;
      }

      // Are we holding?
      hold = (/a=(sendonly|inactive)/).test(request.body);

      this.mediaHandler.setDescription(
        request.body,
        /*
         * onSuccess
         * SDP Offer is valid
         */
        function() {
          self.mediaHandler.getDescription(
            function(body) {
              request.reply(200, null, ['Contact: ' + self.contact], body,
                function() {
                  self.status = C.STATUS_WAITING_FOR_ACK;
                  self.setInvite2xxTimer(request, body);
                  self.setACKTimer();

                  if (self.remote_hold && !hold) {
                    self.onunhold('remote');
                  } else if (!self.remote_hold && hold) {
                    self.onhold('remote');
                  }
                });
            },
            function() {
              request.reply(500);
            },
            self.mediaHint
          );
        },
        /*
         * onFailure
         * Bad media description
         */
        function(e) {
          self.logger.error(e);
          request.reply(488);
        }
      );
    }
  },

  sendReinvite: function(options) {
    options = options || {};

    var
      self = this,
       extraHeaders = options.extraHeaders || [],
       eventHandlers = options.eventHandlers || {},
       mangle = options.mangle || null;

    if (eventHandlers.succeeded) {
      this.reinviteSucceeded = eventHandlers.succeeded;
    } else {
      this.reinviteSucceeded = function(){
        window.clearTimeout(self.timers.ackTimer);
        window.clearTimeout(self.timers.invite2xxTimer);
        self.status = C.STATUS_CONFIRMED;
      };
    }
    if (eventHandlers.failed) {
      this.reinviteFailed = eventHandlers.failed;
    } else {
      this.reinviteFailed = function(){};
    }

    extraHeaders.push('Contact: ' + this.contact);
    extraHeaders.push('Allow: '+ SIP.Utils.getAllowedMethods(this.ua));
    extraHeaders.push('Content-Type: application/sdp');

    this.receiveResponse = this.receiveReinviteResponse;
    //REVISIT
    this.mediaHandler.getDescription(
      function(body){
        if (mangle) {
          body = mangle(body);
        }

        self.dialog.sendRequest(self, SIP.C.INVITE, {
          extraHeaders: extraHeaders,
          body: body
        });
      },
      function() {
        if (self.isReadyToReinvite()) {
          self.onReadyToReinvite();
        }
        self.reinviteFailed();
      },
      self.mediaHint
    );
  },

  /**
   * Reception of Response for in-dialog INVITE
   * @private
   */
  receiveReinviteResponse: function(response) {
    var self = this,
        contentType = response.getHeader('Content-Type');

    if (this.status === C.STATUS_TERMINATED) {
      return;
    }

    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        break;
      case /^2[0-9]{2}$/.test(response.status_code):
        this.status = C.STATUS_CONFIRMED;
        
        this.sendRequest(SIP.C.ACK,{cseq:response.cseq});

        if(!response.body) {
          this.reinviteFailed();
          break;
        } else if (contentType !== 'application/sdp') {
          this.reinviteFailed();
          break;
        }

        //REVISIT
        this.mediaHandler.setDescription(
          response.body,
          /*
           * onSuccess
           * SDP Answer fits with Offer.
           */
          function() {
            self.reinviteSucceeded();
          },
          /*
           * onFailure
           * SDP Answer does not fit the Offer.
           */
          function() {
            self.reinviteFailed();
          }
        );
        break;
      default:
        this.reinviteFailed();
    }
  },

  acceptAndTerminate: function(response, status_code, reason_phrase) {
    var extraHeaders = [];

    if (status_code) {
      reason_phrase = reason_phrase || SIP.C.REASON_PHRASE[status_code] || '';
      extraHeaders.push('Reason: SIP ;cause=' + status_code + '; text="' + reason_phrase + '"');
    }

    // An error on dialog creation will fire 'failed' event
    if (this.dialog || this.createDialog(response, 'UAC')) {
      this.sendRequest(SIP.C.ACK,{cseq: response.cseq});
      this.sendRequest(SIP.C.BYE, {
        extraHeaders: extraHeaders
      });
    }

    return this;
  },

  /**
   * RFC3261 13.3.1.4
   * Response retransmissions cannot be accomplished by transaction layer
   *  since it is destroyed when receiving the first 2xx answer
   */
  setInvite2xxTimer: function(request, body) {
    var self = this,
        timeout = SIP.Timers.T1;

    this.timers.invite2xxTimer = window.setTimeout(function invite2xxRetransmission() {
      if (self.status !== C.STATUS_WAITING_FOR_ACK) {
        return;
      }

      request.reply(200, null, ['Contact: ' + self.contact], body);

      timeout = Math.min(timeout * 2, SIP.Timers.T2);

      self.timers.invite2xxTimer = window.setTimeout(invite2xxRetransmission, timeout);
    }, timeout);
  },

  /**
   * RFC3261 14.2
   * If a UAS generates a 2xx response and never receives an ACK,
   *  it SHOULD generate a BYE to terminate the dialog.
   */
  setACKTimer: function() {
    var self = this;

    this.timers.ackTimer = window.setTimeout(function() {
      if(self.status === C.STATUS_WAITING_FOR_ACK) {
        self.logger.log('no ACK received, terminating the call');
        window.clearTimeout(self.timers.invite2xxTimer);
        self.sendRequest(SIP.C.BYE);
        self.terminated(null, SIP.C.causes.NO_ACK);
      }
    }, SIP.Timers.TIMER_H);
  },

  /*
   * @private
   */
  onReadyToReinvite: function() {
    var action = this.pending_actions.shift();

    if (!action || !this[action.name]) {
      return;
    }

    this[action.name]();
  },

  onTransportError: function() {
    if (this.status === C.STATUS_CONFIRMED) {
      this.terminated(null, SIP.C.causes.CONNECTION_ERROR);
    } else if (this.status !== C.STATUS_TERMINATED) {
      this.failed(null, SIP.C.causes.CONNECTION_ERROR);
    }
  },

  onRequestTimeout: function() {
    if (this.status === C.STATUS_CONFIRMED) {
      this.terminated(null, SIP.C.causes.REQUEST_TIMEOUT);
    } else if (this.status !== C.STATUS_TERMINATED) {
      this.failed(null, SIP.C.causes.REQUEST_TIMEOUT);
    }
  },

  onDialogError: function(response) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.terminated(response, SIP.C.causes.DIALOG_ERROR);
    } else if (this.status !== C.STATUS_TERMINATED) {
      this.failed(response, SIP.C.causes.DIALOG_ERROR);
    }
  },

  /**
   * @private
   */
  onhold: function(originator) {
    this[originator === 'local' ? 'local_hold' : 'remote_hold'] = true;
    this.emit('hold', { originator: originator });
  },

  /**
   * @private
   */
  onunhold: function(originator) {
    this[originator === 'local' ? 'local_hold' : 'remote_hold'] = false;
    this.emit('unhold', { originator: originator });
  },

  /*
   * @private
   */
  onmute: function(options) {
    this.emit('muted', {
      audio: options.audio,
      video: options.video
    });
  },

  /*
   * @private
   */
  onunmute: function(options) {
    this.emit('unmuted', {
      audio: options.audio,
      video: options.video
    });
  },

  failed: function(response, cause) {
    var code = response ? response.status_code : null;

    this.close();
    return this.emit('failed', {
      response: response || null,
      cause: cause,
      code: code
    });
  },

  rejected: function(response, cause) {
    this.close();
    return this.emit('rejected',
      response || null,
      cause
    );
  },

  referred: function(request, referSession) {
    return this.emit(
      'referred',
      request || null,
      referSession || null
    );
  },

  canceled: function() {
    this.close();
    return this.emit('cancel');
  },

  accepted: function(response) {
    var code = response ? response.status_code : null;

    this.startTime = new Date();

    return this.emit('accepted', {
      code: code,
      response: response || null
    });
  },

  terminated: function(message, cause) {
    this.endTime = new Date();

    this.close();
    return this.emit('terminated', {
      message: message || null,
      cause: cause || null
    });
  },

  connecting: function(request) {
    return this.emit('connecting', { request: request });
  }
};

Session.C = C;
SIP.Session = Session;


InviteServerContext = function(ua, request) {
  var expires,
    self = this,
    contentType = request.getHeader('Content-Type'),
    contentDisp = request.getHeader('Content-Disposition');

  // Check body and content type
  if ((!contentDisp && contentType !== 'application/sdp') || contentDisp === 'render') {
    this.renderbody = request.body;
    this.rendertype = contentType;
  } else if (contentType !== 'application/sdp' && (contentDisp && contentDisp === 'session')) {
    request.reply(415);
    //TODO: instead of 415, pass off to the media handler, who can then decide if we can use it
    return;
  }

  //TODO: move this into media handler
  if (request.body && window.mozRTCPeerConnection !== undefined) {
    request.body = request.body.
      replace(/relay/g,"host generation 0").
      replace(/ \r\n/g, "\r\n");
  }

  SIP.Utils.augment(this, SIP.ServerContext, [ua, request]);
  SIP.Utils.augment(this, SIP.Session, [ua.configuration.mediaHandlerFactory]);

  this.status = C.STATUS_INVITE_RECEIVED;
  this.from_tag = request.from_tag;
  this.id = request.call_id + this.from_tag;
  this.request = request;
  this.contact = this.ua.contact.toString();

  this.logger = ua.getLogger('sip.inviteservercontext', this.id);

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  //Get the Expires header value if exists
  if(request.hasHeader('expires')) {
    expires = request.getHeader('expires') * 1000;
  }

  //Set 100rel if necessary
  function set100rel(h,c) {
    if (request.hasHeader(h) && request.getHeader(h).toLowerCase().indexOf('100rel') >= 0) {
      self.rel100 = c;
    }
  }
  set100rel('require', SIP.C.supported.REQUIRED);
  set100rel('supported', SIP.C.supported.SUPPORTED);

  /* Set the to_tag before
   * replying a response code that will create a dialog.
   */
  request.to_tag = SIP.Utils.newTag();

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS', true)) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  //Initialize Media Session
  this.mediaHandler = this.mediaHandlerFactory(this, {
    RTCConstraints: {"optional": [{'DtlsSrtpKeyAgreement': 'true'}]}
  });

  function fireNewSession() {
    var options = {extraHeaders: ['Contact: ' + self.contact]};

    if (self.rel100 !== SIP.C.supported.REQUIRED) {
      self.progress(options);
    }
    self.status = C.STATUS_WAITING_FOR_ANSWER;

    // Set userNoAnswerTimer
    self.timers.userNoAnswerTimer = window.setTimeout(function() {
      request.reply(408);
      self.failed(request, SIP.C.causes.NO_ANSWER);
    }, self.ua.configuration.noAnswerTimeout);

    /* Set expiresTimer
     * RFC3261 13.3.1
     */
    if (expires) {
      self.timers.expiresTimer = window.setTimeout(function() {
        if(self.status === C.STATUS_WAITING_FOR_ANSWER) {
          request.reply(487);
          self.failed(request, SIP.C.causes.EXPIRES);
        }
      }, expires);
    }

    self.emit('invite',request);
  }

  if (!request.body || this.renderbody) {
    setTimeout(fireNewSession, 0);
  } else {
    this.hasOffer = true;
    this.mediaHandler.setDescription(
      request.body,
      /*
       * onSuccess
       * SDP Offer is valid. Fire UA newRTCSession
       */
      fireNewSession,
      /*
       * onFailure
       * Bad media description
       */
      function(e) {
        self.logger.warn('invalid SDP');
        self.logger.warn(e);
        request.reply(488);
      }
    );
  }
};

InviteServerContext.prototype = {
  reject: function(options) {
    // Check Session Status
    if (this.status === C.STATUS_TERMINATED) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    this.logger.log('rejecting RTCSession');

    SIP.ServerContext.prototype.reject.apply(this, [options]);
    return this.terminated();
  },

  terminate: function(options) {
    options = options || {};

    var
    extraHeaders = options.extraHeaders || [],
    body = options.body,
    dialog,
    self = this;

    if (this.status === C.STATUS_WAITING_FOR_ACK &&
       this.request.server_transaction.state !== SIP.Transactions.C.STATUS_TERMINATED) {
      dialog = this.dialog;

      this.receiveRequest = function(request) {
        if (request.method === SIP.C.ACK) {
          this.request(SIP.C.BYE, {
            extraHeaders: extraHeaders,
            body: body
          });
          dialog.terminate();
        }
      };

      this.request.server_transaction.on('stateChanged', function(){
        if (this.state === SIP.Transactions.C.STATUS_TERMINATED) {
          this.request = new SIP.OutgoingRequest(
            SIP.C.BYE,
            this.dialog.remote_target,
            this.ua,
            {
              'cseq': this.dialog.local_seqnum+=1,
              'call_id': this.dialog.id.call_id,
              'from_uri': this.dialog.local_uri,
              'from_tag': this.dialog.id.local_tag,
              'to_uri': this.dialog.remote_uri,
              'to_tag': this.dialog.id.remote_tag,
              'route_set': this.dialog.route_set
            },
            extraHeaders,
            body
          );
          
          new SIP.RequestSender(
            {
              request: this.request,
              onRequestTimeout: function() {
                self.onRequestTimeout();
              },
              onTransportError: function() {
                self.onTransportError();
              },
              receiveResponse: function() {
                return;
              }
            },
            this.ua
          ).send();
          dialog.terminate();
        }
      });

      this.emit('bye', this.request);
      this.terminated();

      // Restore the dialog into 'this' in order to be able to send the in-dialog BYE :-)
      this.dialog = dialog;

      // Restore the dialog into 'ua' so the ACK can reach 'this' session
      this.ua.dialogs[dialog.id.toString()] = dialog;

    } else if (this.status === C.STATUS_CONFIRMED) {
      this.bye(options);
    } else {
      this.reject(options);
    }

    return this;
  },

  /*
   * @param {Object} [options.media] gets passed to SIP.MediaHandler.getDescription as mediaHint
   */
  progress: function (options) {
    options = options || {};
    var
      statusCode = options.statusCode || 180,
      reasonPhrase = options.reasonPhrase,
      extraHeaders = options.extraHeaders || [],
      body = options.body,
      response;

    if (statusCode < 100 || statusCode > 199) {
      throw new TypeError('Invalid statusCode: ' + statusCode);
    }

    if (this.isCanceled || this.status === C.STATUS_TERMINATED) {
      return this;
    }

    function do100rel() {
      statusCode = options.statusCode || 183;

      // Set status and add extra headers
      this.status = C.STATUS_WAITING_FOR_PRACK;
      extraHeaders.push('Contact: '+ this.contact);
      extraHeaders.push('Require: 100rel');
      extraHeaders.push('RSeq: ' + Math.floor(Math.random() * 10000));

      // Save media hint for later (referred sessions)
      this.mediaHint = options.media;

      // Get the session description to add to preaccept with
      this.mediaHandler.getDescription(
        // Success
        function succ(body) {
          if (this.isCanceled || this.status === C.STATUS_TERMINATED) {
            return;
          }

          this.early_sdp = body;
          this[this.hasOffer ? 'hasAnswer' : 'hasOffer'] = true;

          // Retransmit until we get a response or we time out (see prackTimer below)
          var timeout = SIP.Timers.T1;
          this.timers.rel1xxTimer = window.setTimeout(function rel1xxRetransmission() {
            this.request.reply(statusCode, null, extraHeaders, body);
            timeout *= 2;
            this.timers.rel1xxTimer = window.setTimeout(rel1xxRetransmission, timeout);
          }.bind(this), timeout);

          // Timeout and reject INVITE if no response
          this.timers.prackTimer = window.setTimeout(function () {
            if (this.status !== C.STATUS_WAITING_FOR_PRACK) {
              return;
            }

            this.logger.log('no PRACK received, rejecting the call');
            window.clearTimeout(this.timers.rel1xxTimer);
            this.request.reply(504);
            this.terminated(null, SIP.C.causes.NO_PRACK);
          }.bind(this), SIP.Timers.T1 * 64);

          // Send the initial response
          response = this.request.reply(statusCode, reasonPhrase, extraHeaders, body);
          this.emit('progress', response); // TODO - include arguments here
        }.bind(this),

        // Failure
        function fail() {
          this.failed(null, SIP.C.causes.WEBRTC_ERROR);
        }.bind(this),

        // Media hint:
        options.media);
    } // end do100rel

    function normalReply() {
      response = this.request.reply(statusCode, reasonPhrase, extraHeaders, body);
      this.emit('progress', response);
    }

    if (options.statusCode !== 100 &&
        (this.rel100 === SIP.C.supported.REQUIRED ||
         (this.rel100 === SIP.C.supported.SUPPORTED && options.rel100))) {
      do100rel.apply(this);
    } else {
      normalReply.apply(this);
    }
    return this;
  },

  /*
   * @param {Object} [options.media] gets passed to SIP.MediaHandler.getDescription as mediaHint
   */
  accept: function(options) {
    options = options || {};

    SIP.Utils.optionsOverride(options, 'media', 'mediaConstraints', true, this.logger, this.ua.configuration.media);
    this.mediaHint = options.media;

    // commented out now-unused hold-related variables for jshint. See below. JMF 2014-1-21
    var
      //idx, length, hasAudio, hasVideo,
      self = this,
      request = this.request,
      extraHeaders = options.extraHeaders || [],
    //mediaStream = options.mediaStream || null,
      sdpCreationSucceeded = function(body) {
        var
          // run for reply success callback
          replySucceeded = function() {
            self.status = C.STATUS_WAITING_FOR_ACK;

            self.setInvite2xxTimer(request, body);
            self.setACKTimer();
            if (self.hasAnswer) {
              self.accepted();
            }
          },

          // run for reply failure callback
          replyFailed = function() {
            self.failed(null, SIP.C.causes.CONNECTION_ERROR);
          };

        extraHeaders.push('Contact: ' + self.contact);

        if(!self.hasOffer) {
          self.hasOffer = true;
        } else {
          self.hasAnswer = true;
        }
        request.reply(200, null, extraHeaders,
                      body,
                      replySucceeded,
                      replyFailed
                     );
      },

      sdpCreationFailed = function() {
        if (self.status === C.STATUS_TERMINATED) {
          return;
        }
        // TODO - fail out on error
        //response = request.reply(480);
        //self.failed(response, SIP.C.causes.USER_DENIED_MEDIA_ACCESS);
        self.failed(null, SIP.C.causes.WEBRTC_ERROR);
      };

    // Check Session Status
    if (this.status === C.STATUS_WAITING_FOR_PRACK) {
      this.status = C.STATUS_ANSWERED_WAITING_FOR_PRACK;
      return this;
    } else if (this.status === C.STATUS_WAITING_FOR_ANSWER) {
      this.status = C.STATUS_ANSWERED;
    } else if (this.status !== C.STATUS_EARLY_MEDIA) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    // An error on dialog creation will fire 'failed' event
    if(!this.createDialog(request, 'UAS')) {
      request.reply(500, 'Missing Contact header field');
      return this;
    }

    window.clearTimeout(this.timers.userNoAnswerTimer);

    extraHeaders.unshift('Contact: ' + self.contact);

    // this hold-related code breaks FF accepting new calls - JMF 2014-1-21
    /*
    length = this.getRemoteStreams().length;

    for (idx = 0; idx < length; idx++) {
      if (this.mediaHandler.getRemoteStreams()[idx].getVideoTracks().length > 0) {
        hasVideo = true;
      }
      if (this.mediaHandler.getRemoteStreams()[idx].getAudioTracks().length > 0) {
        hasAudio = true;
      }
    }

    if (!hasAudio && this.mediaConstraints.audio === true) {
      this.mediaConstraints.audio = false;
      if (mediaStream) {
        length = mediaStream.getAudioTracks().length;
        for (idx = 0; idx < length; idx++) {
          mediaStream.removeTrack(mediaStream.getAudioTracks()[idx]);
        }
      }
    }

    if (!hasVideo && this.mediaConstraints.video === true) {
      this.mediaConstraints.video = false;
      if (mediaStream) {
        length = mediaStream.getVideoTracks().length;
        for (idx = 0; idx < length; idx++) {
          mediaStream.removeTrack(mediaStream.getVideoTracks()[idx]);
        }
      }
    }
    */

    if (this.status === C.STATUS_EARLY_MEDIA) {
      sdpCreationSucceeded();
    } else {
      this.mediaHandler.getDescription(
        sdpCreationSucceeded,
        sdpCreationFailed,
        self.mediaHint
      );
    }

    return this;
  },

  receiveRequest: function(request) {
    var contentType, session = this, referSession;//,localMedia;

    function confirmSession() {
      //localMedia = session.mediaHandler.localMedia;
      window.clearTimeout(session.timers.ackTimer);
      window.clearTimeout(session.timers.invite2xxTimer);
      session.status = C.STATUS_CONFIRMED;
      contentType = request.getHeader('Content-Type');
      //REVISIT
      session.unmute();
      session.accepted();
      if (contentType !== 'application/sdp') {
        //custom data will be here
        session.renderbody = request.body;
        session.rendertype = request.getHeader('Content-type');
      }
    }

    switch(request.method) {
      case SIP.C.CANCEL:
        /* RFC3261 15 States that a UAS may have accepted an invitation while a CANCEL
         * was in progress and that the UAC MAY continue with the session established by
         * any 2xx response, or MAY terminate with BYE. SIP does continue with the
         * established session. So the CANCEL is processed only if the session is not yet
         * established.
         */

        /*
         * Terminate the whole session in case the user didn't accept (or yet to send the answer) nor reject the
         *request opening the session.
         */
        if(this.status === C.STATUS_WAITING_FOR_ANSWER ||
           this.status === C.STATUS_WAITING_FOR_PRACK ||
           this.status === C.STATUS_ANSWERED_WAITING_FOR_PRACK ||
           this.status === C.STATUS_EARLY_MEDIA ||
           this.status === C.STATUS_ANSWERED) {

          this.status = C.STATUS_CANCELED;
          this.request.reply(487);
          this.canceled(request);
          this.rejected(request, SIP.C.causes.CANCELED);
          this.failed(request, SIP.C.causes.CANCELED);
        }
        break;
      case SIP.C.ACK:
        if(this.status === C.STATUS_WAITING_FOR_ACK) {
          if (!this.hasAnswer) {
            if(request.body && request.getHeader('content-type') === 'application/sdp') {
              // ACK contains answer to an INVITE w/o SDP negotiation
              this.hasAnswer = true;
              this.mediaHandler.setDescription(
                request.body,
                /*
                 * onSuccess
                 * SDP Answer fits with Offer. Media will start
                 */
                confirmSession,
                /*
                 * onFailure
                 * SDP Answer does not fit the Offer.  Terminate the call.
                 */
                function (e) {
                  session.logger.warn(e);
                  session.terminate({
                    statusCode: '488',
                    reasonPhrase: 'Bad Media Description'
                  });
                  session.failed(request, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
                }
              );
            } else if (this.early_sdp) {
              confirmSession();
            } else {
              //TODO: Pass to mediahandler
              this.failed(request, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
            }
          } else {
            confirmSession();
          }
        }
        break;
      case SIP.C.PRACK:
        if (this.status === C.STATUS_WAITING_FOR_PRACK || this.status === C.STATUS_ANSWERED_WAITING_FOR_PRACK) {
          //localMedia = session.mediaHandler.localMedia;
          if(!this.hasAnswer) {
            if(request.body && request.getHeader('content-type') === 'application/sdp') {
              this.hasAnswer = true;
              this.mediaHandler.setDescription(
                request.body,
                /*
                 * onSuccess
                 * SDP Answer fits with Offer. Media will start
                 */
                function() {
                  window.clearTimeout(session.timers.rel1xxTimer);
                  window.clearTimeout(session.timers.prackTimer);
                  request.reply(200);
                  if (session.status === C.STATUS_ANSWERED_WAITING_FOR_PRACK) {
                    session.status = C.STATUS_EARLY_MEDIA;
                    session.accept();
                  }
                  session.status = C.STATUS_EARLY_MEDIA;
                  //REVISIT
                  session.mute();
                  /*if (localMedia.getAudioTracks().length > 0) {
                    localMedia.getAudioTracks()[0].enabled = false;
                  }
                  if (localMedia.getVideoTracks().length > 0) {
                    localMedia.getVideoTracks()[0].enabled = false;
                  }*/
                },
                function (e) {
                  //TODO: Send to media handler
                  session.logger.warn(e);
                  session.terminate({
                    statusCode: '488',
                    reasonPhrase: 'Bad Media Description'
                  });
                  session.failed(request, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
                }
              );
            } else {
              session.terminate({
                statusCode: '488',
                reasonPhrase: 'Bad Media Description'
              });
              session.failed(request, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
            }
          } else {
            window.clearTimeout(session.timers.rel1xxTimer);
            window.clearTimeout(session.timers.prackTimer);
            request.reply(200);

            if (this.status === C.STATUS_ANSWERED_WAITING_FOR_PRACK) {
              this.status = C.STATUS_EARLY_MEDIA;
              this.accept();
            }
            this.status = C.STATUS_EARLY_MEDIA;
            //REVISIT
            session.mute();

            /*localMedia = session.mediaHandler.localMedia;
            if (localMedia.getAudioTracks().length > 0) {
              localMedia.getAudioTracks()[0].enabled = false;
            }
            if (localMedia.getVideoTracks().length > 0) {
              localMedia.getVideoTracks()[0].enabled = false;
            }*/
          }
        } else if(this.status === C.STATUS_EARLY_MEDIA) {
          request.reply(200);
        }
        break;
      case SIP.C.BYE:
        if(this.status === C.STATUS_CONFIRMED) {
          request.reply(200);
          this.emit('bye', request);
          this.terminated(request, SIP.C.causes.BYE);
        }
        break;
      case SIP.C.INVITE:
        if(this.status === C.STATUS_CONFIRMED) {
          this.logger.log('re-INVITE received');
          this.receiveReinvite(request);
        }
        break;
      case SIP.C.INFO:
        if(this.status === C.STATUS_CONFIRMED || this.status === C.STATUS_WAITING_FOR_ACK) {
          contentType = request.getHeader('content-type');
          if (contentType && (contentType.match(/^application\/dtmf-relay/i))) {
            new DTMF(this).init_incoming(request);
          }
        }
        break;
      case SIP.C.REFER:
        if(this.status ===  C.STATUS_CONFIRMED) {
          this.logger.log('REFER received');
          request.reply(202, 'Accepted');
          this.sendRequest(SIP.C.NOTIFY,
            { 
              extraHeaders:[
                'Event: refer',
                'Subscription-State: terminated',
                'Content-Type: message/sipfrag'
               ],
               body:'SIP/2.0 100 Trying'
            });

          // HACK: Stop localMedia so Chrome doesn't get confused about gUM
          if (this.rtcMediaHandler && this.rtcMediaHandler.localMedia) {
            this.rtcMediaHandler.localMedia.stop();
          }

          /*
            Harmless race condition.  Both sides of REFER
            may send a BYE, but in the end the dialogs are destroyed.
          */
          referSession = this.ua.invite(request.parseHeader('refer-to').uri, {
            media: this.mediaHint
          });

          this.referred(request,referSession);

          this.terminate();
        }
        break;
    }
  }

};

SIP.InviteServerContext = InviteServerContext;

InviteClientContext = function(ua, target, options) {
  options = options || {};
  var requestParams, iceServers,
    extraHeaders = options.extraHeaders || [],
    stunServers = options.stunServers || null,
    turnServers = options.turnServers || null;

  // Check WebRTC support
  if (!SIP.WebRTC.isSupported) {
    throw new SIP.Exceptions.NotSupportedError('WebRTC not supported');
  }

  this.RTCConstraints = options.RTCConstraints || {};
  this.inviteWithoutSdp = options.inviteWithoutSdp || false;

  // Set anonymous property
  this.anonymous = options.anonymous || false;

  // Custom data to be sent either in INVITE or in ACK
  this.renderbody = options.renderbody || null;
  this.rendertype = options.rendertype || null;

  requestParams = {from_tag: this.from_tag};

  /* Do not add ;ob in initial forming dialog requests if the registration over
   *  the current connection got a GRUU URI.
   */
  this.contact = ua.contact.toString({
    anonymous: this.anonymous,
    outbound: this.anonymous ? !ua.contact.temp_gruu : !ua.contact.pub_gruu
  });

  if (this.anonymous) {
    requestParams.from_displayName = 'Anonymous';
    requestParams.from_uri = 'sip:anonymous@anonymous.invalid';

    extraHeaders.push('P-Preferred-Identity: '+ ua.configuration.uri.toString());
    extraHeaders.push('Privacy: id');
  }
  extraHeaders.push('Contact: '+ this.contact);
  extraHeaders.push('Allow: '+ SIP.Utils.getAllowedMethods(ua));
  if (!this.inviteWithoutSdp) {
    extraHeaders.push('Content-Type: application/sdp');
  } else if (this.renderbody) {
    extraHeaders.push('Content-Type: ' + this.rendertype);
    extraHeaders.push('Content-Disposition: render');
  }

  if (ua.configuration.reliable === 'required') {
    extraHeaders.push('Require: 100rel');
  }

  options.extraHeaders = extraHeaders;
  options.params = requestParams;

  SIP.Utils.augment(this, SIP.ClientContext, [ua, SIP.C.INVITE, target, options]);
  SIP.Utils.augment(this, SIP.Session, [ua.configuration.mediaHandlerFactory]);

  // Check Session Status
  if (this.status !== C.STATUS_NULL) {
    throw new SIP.Exceptions.InvalidStateError(this.status);
  }

  // Session parameter initialization
  this.from_tag = SIP.Utils.newTag();

  // OutgoingSession specific parameters
  this.isCanceled = false;
  this.received_100 = false;

  this.method = SIP.C.INVITE;

  this.receiveNonInviteResponse = this.receiveResponse;
  this.receiveResponse = this.receiveInviteResponse;

  this.logger = ua.getLogger('sip.inviteclientcontext');

  if (stunServers) {
    iceServers = SIP.UA.configuration_check.optional['stunServers'](stunServers);
    if (!iceServers) {
      throw new TypeError('Invalid stunServers: '+ stunServers);
    } else {
      this.stunServers = iceServers;
    }
  }

  if (turnServers) {
    iceServers = SIP.UA.configuration_check.optional['turnServers'](turnServers);
    if (!iceServers) {
      throw new TypeError('Invalid turnServers: '+ turnServers);
    } else {
      this.turnServers = iceServers;
    }
  }

  ua.applicants[this] = this;

  this.id = this.request.call_id + this.from_tag;

  //Initialize Media Session
  this.mediaHandler = this.mediaHandlerFactory(this, {
    RTCConstraints: this.RTCConstraints,
    stunServers: this.stunServers,
    turnServers: this.turnServers
  });
};

InviteClientContext.prototype = {
  /*
   * @param {Object} [options.media] gets passed to SIP.MediaHandler.getDescription as mediaHint
   */
  invite: function (options) {
    var self = this;
    options = options || {};

    SIP.Utils.optionsOverride(options, 'media', 'mediaConstraints', true, this.logger, this.ua.configuration.media);
    self.mediaHint = options.media;

    //Save the session into the ua sessions collection.
    //Note: placing in constructor breaks call to request.cancel on close... User does not need this anyway
    this.ua.sessions[this.id] = this;

    if (this.inviteWithoutSdp) {
      //just send an invite with no sdp...
      this.request.body = self.renderbody;
      this.status = C.STATUS_INVITE_SENT;
      this.send();
    } else {
      this.mediaHandler.getDescription(
        function onSuccess(offer) {
          if (self.isCanceled || self.status === C.STATUS_TERMINATED) {
            return;
          }
          self.hasOffer = true;
          self.request.body = offer;
          self.status = C.STATUS_INVITE_SENT;
          self.send();
        },
        function onFailure() {
          if (self.status === C.STATUS_TERMINATED) {
            return;
          }
          // TODO...fail out
          //self.failed(null, SIP.C.causes.USER_DENIED_MEDIA_ACCESS);
          //self.failed(null, SIP.C.causes.WEBRTC_ERROR);
          self.failed(null, SIP.C.causes.WEBRTC_ERROR);
        },
        self.mediaHint
      );
    }

    return this;
  },

  receiveInviteResponse: function(response) {
    var cause, //localMedia,
      session = this,
      id = response.call_id + response.from_tag + response.to_tag,
      extraHeaders = [],
      options = {};

    if (this.dialog && (response.status_code >= 200 && response.status_code <= 299)) {
      if (id !== this.dialog.id.toString() ) {
        if (!this.createDialog(response, 'UAC', true)) {
          return;
        }
        this.earlyDialogs[id].sendRequest(this, SIP.C.ACK);
        this.earlyDialogs[id].sendRequest(this, SIP.C.BYE);
        //session.failed(response, SIP.C.causes.WEBRTC_ERROR);
        return;
      } else if (this.status === C.STATUS_CONFIRMED) {
        this.sendRequest(SIP.C.ACK,{cseq: response.cseq});
        return;
      }
    }

   /* if (this.status !== C.STATUS_INVITE_SENT && this.status !== C.STATUS_1XX_RECEIVED && this.status !== C.STATUS_EARLY_MEDIA) {
      if (response.statusCode !== 200) {
        return;
      }
    } else */if (this.status === C.STATUS_EARLY_MEDIA && response.status_code !== 200) {
      // Early media has been set up with at least one other different branch, but a final 2xx response hasn't been received
      if (!this.earlyDialogs[id]) {
        this.createDialog(response, 'UAC', true);
      }
      extraHeaders.push('RAck: ' + response.getHeader('rseq') + ' ' + response.getHeader('cseq'));
      this.earlyDialogs[id].pracked.push(response.getHeader('rseq'));

      this.earlyDialogs[id].sendRequest(this, SIP.C.PRACK, {
        extraHeaders: extraHeaders
      });
      return;
    }

    // Proceed to cancellation if the user requested.
    if(this.isCanceled) {
      if(response.status_code >= 100 && response.status_code < 200) {
        this.request.cancel(this.cancelReason);
        this.canceled(null);
      } else if(response.status_code >= 200 && response.status_code < 299) {
        this.acceptAndTerminate(response);
        this.emit('bye', this.request);
      }
      return;
    }

    switch(true) {
      case /^100$/.test(response.status_code):
        this.received_100 = true;
        break;
      case (/^1[0-9]{2}$/.test(response.status_code)):
        // Do nothing with 1xx responses without To tag.
        if(!response.to_tag) {
          this.logger.warn('1xx response received without to tag');
          break;
        }

        // Create Early Dialog if 1XX comes with contact
        if(response.hasHeader('contact')) {
          // An error on dialog creation will fire 'failed' event
          if (!this.createDialog(response, 'UAC', true)) {
            break;
          }
        }

        this.status = C.STATUS_1XX_RECEIVED;
        this.emit('progress', {
          response: response || null
        });

        if(response.hasHeader('require') &&
           response.getHeader('require').indexOf('100rel') !== -1) {

          // Do nothing if this.dialog is already confirmed
          if (this.dialog || !this.earlyDialogs[id]) {
            break;
          }

          if (this.earlyDialogs[id].pracked.indexOf(response.getHeader('rseq')) !== -1 ||
              (this.earlyDialogs[id].pracked[this.earlyDialogs[id].pracked.length-1] >= response.getHeader('rseq') && this.earlyDialogs[id].pracked.length > 0)) {
            return;
          }

          if (response.body && window.mozRTCPeerConnection !== undefined) {
            response.body = response.body.replace(/relay/g, 'host generation 0');
            response.body = response.body.replace(/ \r\n/g, '\r\n');
          }

          if (!response.body) {
            extraHeaders.push('RAck: ' + response.getHeader('rseq') + ' ' + response.getHeader('cseq'));
            this.earlyDialogs[id].pracked.push(response.getHeader('rseq'));
            this.earlyDialogs[id].sendRequest(this, SIP.C.PRACK, {
              extraHeaders: extraHeaders
            });
          } else if (this.hasOffer) {
            if (!this.createDialog(response, 'UAC')) {
              break;
            }
            this.hasAnswer = true;
            this.mediaHandler.setDescription(
              response.body,
              /*
               * onSuccess
               * SDP Answer fits with Offer. Media will start
               */
              function () {
                extraHeaders.push('RAck: ' + response.getHeader('rseq') + ' ' + response.getHeader('cseq'));
                session.dialog.pracked.push(response.getHeader('rseq'));

                session.sendRequest(SIP.C.PRACK, {
                  extraHeaders: extraHeaders
                });
                session.status = C.STATUS_EARLY_MEDIA;
                session.mute();
                /*
                if (session.status === C.STATUS_EARLY_MEDIA) {
                  localMedia = session.mediaHandler.localMedia;
                  if (localMedia.getAudioTracks().length > 0) {
                    localMedia.getAudioTracks()[0].enabled = false;
                  }
                  if (localMedia.getVideoTracks().length > 0) {
                    localMedia.getVideoTracks()[0].enabled = false;
                  }
                }*/
              },
              /*
               * onFailure
               * SDP Answer does not fit the Offer. Accept the call and Terminate.
               */
              function(e) {
                session.logger.warn(e);
                session.acceptAndTerminate(response, 488, 'Not Acceptable Here');
                session.failed(response, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
              }
            );
          } else {
            this.earlyDialogs[id].mediaHandler.setDescription(
              response.body,
              function onSuccess() {
                session.earlyDialogs[id].mediaHandler.getDescription(
                  function onSuccess(sdp) {
                    extraHeaders.push('Content-Type: application/sdp');
                    extraHeaders.push('RAck: ' + response.getHeader('rseq') + ' ' + response.getHeader('cseq'));
                    session.earlyDialogs[id].pracked.push(response.getHeader('rseq'));
                    session.earlyDialogs[id].sendRequest(session, SIP.C.PRACK, {
                      extraHeaders: extraHeaders,
                      body: sdp
                    });
                  },
                  function onFailure() {
                    if (session.status === C.STATUS_TERMINATED) {
                      return;
                    }
                    // TODO - fail out on error
                    // session.failed(gum error);
                    session.failed(null, SIP.C.causes.WEBRTC_ERROR);
                  },
                  session.mediaHint
                );
              },
              function onFailure(e) {
                // Could not set remote description
                session.logger.warn('invalid SDP');
                session.logger.warn(e);
              }
            );
          }
        }
        break;
      case /^2[0-9]{2}$/.test(response.status_code):
        var cseq = this.request.cseq + ' ' + this.request.method;
        if (cseq !== response.getHeader('cseq')) {
          break;
        }

        if (this.status === C.STATUS_EARLY_MEDIA) {
          this.status = C.STATUS_CONFIRMED;
          this.unmute();
          /*localMedia = this.mediaHandler.localMedia;
          if (localMedia.getAudioTracks().length > 0) {
            localMedia.getAudioTracks()[0].enabled = true;
          }
          if (localMedia.getVideoTracks().length > 0) {
            localMedia.getVideoTracks()[0].enabled = true;
          }*/
          options = {};
          if (this.renderbody) {
            extraHeaders.push('Content-Type: ' + this.rendertype);
            options.extraHeaders = extraHeaders;
            options.body = this.renderbody;
          }
          options.cseq = response.cseq;
          this.sendRequest(SIP.C.ACK, options);
          this.accepted(response);
          break;
        }
        // Do nothing if this.dialog is already confirmed
        if (this.dialog) {
          break;
        }

        if (response.body && window.mozRTCPeerConnection !== undefined) {
          response.body = response.body.replace(/relay/g, 'host generation 0');
          response.body = response.body.replace(/ \r\n/g, '\r\n');
        }

        // This is an invite without sdp
        if (!this.hasOffer) {
          if (this.earlyDialogs[id] && this.earlyDialogs[id].mediaHandler.localMedia) {
            //REVISIT
            this.hasOffer = true;
            this.hasAnswer = true;
            this.mediaHandler = this.earlyDialogs[id].mediaHandler;
            if (!this.createDialog(response, 'UAC')) {
              break;
            }
            this.status = C.STATUS_CONFIRMED;
            this.sendRequest(SIP.C.ACK, {cseq:response.cseq});

            this.unmute();
            /*
            localMedia = session.mediaHandler.localMedia;
            if (localMedia.getAudioTracks().length > 0) {
              localMedia.getAudioTracks()[0].enabled = true;
            }
            if (localMedia.getVideoTracks().length > 0) {
              localMedia.getVideoTracks()[0].enabled = true;
            }*/
            this.accepted(response);
          } else {
            if(!response.body) {
              this.acceptAndTerminate(response, 400, 'Missing session description');
              this.failed(response, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
              break;
            } 
            if (!this.createDialog(response, 'UAC')) {
              break;
            }
            this.hasOffer = true;
            this.mediaHandler.setDescription(
              response.body,
              function onSuccess() {
                session.mediaHandler.getDescription(
                  function onSuccess(sdp) {
                    //var localMedia;
                    if(session.isCanceled || session.status === C.STATUS_TERMINATED) {
                      return;
                    }
                    /*
                     * This is a Firefox hack to insert valid sdp when getDescription is
                     * called with the constraint offerToReceiveVideo = false.
                     * We search for either a c-line at the top of the sdp above all
                     * m-lines. If that does not exist then we search for a c-line
                     * beneath each m-line. If it is missing a c-line, we insert
                     * a fake c-line with the ip address 0.0.0.0. This is then valid
                     * sdp and no media will be sent for that m-line.
                     *
                     * Valid SDP is:
                     * m=
                     * i=
                     * c=
                     */
                    if (sdp.indexOf('c=') > sdp.indexOf('m=')) {
                      var insertAt;
                      var mlines = (sdp.match(/m=.*\r\n.*/g));
                      for (var i=0; i<mlines.length; i++) {
                        if (mlines[i].toString().search(/i=.*/) >= 0) {
                          insertAt = sdp.indexOf(mlines[i].toString())+mlines[i].toString().length;
                          if (sdp.substr(insertAt,2)!=='c=') {
                            sdp = sdp.substr(0,insertAt) + '\r\nc=IN IP 4 0.0.0.0' + sdp.substr(insertAt);
                          }
                        } else if (mlines[i].toString().search(/c=.*/) < 0) {
                          insertAt = sdp.indexOf(mlines[i].toString().match(/.*/))+mlines[i].toString().match(/.*/).toString().length;
                          sdp = sdp.substr(0,insertAt) + '\r\nc=IN IP4 0.0.0.0' + sdp.substr(insertAt);
                        }
                      }
                    }

                    session.status = C.STATUS_CONFIRMED;

                    session.unmute();
                    /*localMedia = session.mediaHandler.localMedia;
                    if (localMedia.getAudioTracks().length > 0) {
                      localMedia.getAudioTracks()[0].enabled = true;
                    }
                    if (localMedia.getVideoTracks().length > 0) {
                      localMedia.getVideoTracks()[0].enabled = true;
                    }*/
                    session.sendRequest(SIP.C.ACK,{
                      body: sdp,
                      extraHeaders:['Content-Type: application/sdp'],
                      cseq:response.cseq
                    });
                    session.accepted(response);
                  },
                  function onFailure() {
                    // TODO do something here
                    console.log("there was a problem");
                  },
                  session.mediaHint
                );
              },
              function onFailure(e) {
                session.logger.warn('invalid SDP');
                session.logger.warn(e);
                response.reply(488);
              }
            );
          }
        } else if (this.hasAnswer){
          if (this.renderbody) {
            extraHeaders.push('Content-Type: ' + session.rendertype);
            options.extraHeaders = extraHeaders;
            options.body = this.renderbody;
          }
          this.sendRequest(SIP.C.ACK, options);
        } else {
          if(!response.body) {
            this.acceptAndTerminate(response, 400, 'Missing session description');
            this.failed(response, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
            break;
          } 
          if (!this.createDialog(response, 'UAC')) {
            break;
          }
          this.hasAnswer = true;
          this.mediaHandler.setDescription(
            response.body,
            /*
             * onSuccess
             * SDP Answer fits with Offer. Media will start
             */
            function() {
              var options = {};//,localMedia;
              session.status = C.STATUS_CONFIRMED;
              session.unmute();
              /*localMedia = session.mediaHandler.localMedia;
              if (localMedia.getAudioTracks().length > 0) {
                localMedia.getAudioTracks()[0].enabled = true;
              }
              if (localMedia.getVideoTracks().length > 0) {
                localMedia.getVideoTracks()[0].enabled = true;
              }*/
              if (session.renderbody) {
                extraHeaders.push('Content-Type: ' + session.rendertype);
                options.extraHeaders = extraHeaders;
                options.body = session.renderbody;
              }
              options.cseq = response.cseq;
              session.sendRequest(SIP.C.ACK, options);
              session.accepted(response);
            },
            /*
             * onFailure
             * SDP Answer does not fit the Offer. Accept the call and Terminate.
             */
            function(e) {
              session.logger.warn(e);
              session.acceptAndTerminate(response, 488, 'Not Acceptable Here');
              session.failed(response, SIP.C.causes.BAD_MEDIA_DESCRIPTION);
            }
          );
        }
        break;
      default:
        cause = SIP.Utils.sipErrorCause(response.status_code);
        this.failed(response, cause);
        this.rejected(response, cause);
    }
  },

  cancel: function(options) {
    options = options || {};

    var
    statusCode = options.status_code,
    reasonPhrase = options.reasonPhrase,
    cancel_reason;

    // Check Session Status
    if (this.status === C.STATUS_TERMINATED) {
      throw new SIP.Exceptions.InvalidStateError(this.status);
    }

    this.logger.log('canceling RTCSession');

    if (statusCode && (statusCode < 200 || statusCode >= 700)) {
      throw new TypeError('Invalid status_code: '+ statusCode);
    } else if (statusCode) {
      reasonPhrase = reasonPhrase || SIP.C.REASON_PHRASE[statusCode] || '';
      cancel_reason = 'SIP ;cause=' + statusCode + ' ;text="' + reasonPhrase + '"';
    }

    // Check Session Status
    if (this.status === C.STATUS_NULL ||
        (this.status === C.STATUS_INVITE_SENT && !this.received_100)) {
      this.isCanceled = true;
      this.cancelReason = cancel_reason;
    } else if (this.status === C.STATUS_INVITE_SENT ||
               this.status === C.STATUS_1XX_RECEIVED) {
      this.request.cancel(cancel_reason);
    }

    return this.canceled();
  },

  terminate: function(options) {
    if (this.status === C.STATUS_TERMINATED) {
      return this;
    }

    if (this.status === C.STATUS_WAITING_FOR_ACK || this.status === C.STATUS_CONFIRMED) {
      this.bye(options);
    } else {
      this.cancel(options);
    }

    return this.terminated();
  },

  receiveRequest: function(request) {
    var contentType, referSession, response;

    if(request.method === SIP.C.CANCEL) {
      /* RFC3261 15 States that a UAS may have accepted an invitation while a CANCEL
       * was in progress and that the UAC MAY continue with the session established by
       * any 2xx response, or MAY terminate with BYE. SIP does continue with the
       * established session. So the CANCEL is processed only if the session is not yet
       * established.
       */

      /*
       * Terminate the whole session in case the user didn't accept nor reject the
       *request opening the session.
       */
      if(this.status === C.STATUS_EARLY_MEDIA) {
        this.status = C.STATUS_CANCELED;
        response = this.request.reply(487);
        this.canceled(response);
        this.rejected(response, SIP.C.causes.CANCELED);
        this.failed(response, SIP.C.causes.CANCELED);
      }
    } else {
      // Requests arriving here are in-dialog requests.
      switch(request.method) {
        case SIP.C.BYE:
          request.reply(200);
          this.emit('bye', request);
          this.terminated(request, SIP.C.causes.BYE);
          break;
        case SIP.C.INVITE:
          this.logger.log('re-INVITE received');
          this.receiveReinvite(request);
          break;
        case SIP.C.ACK:
          if(this.status === C.STATUS_WAITING_FOR_ACK) {
            window.clearTimeout(this.timers.ackTimer);
            window.clearTimeout(this.timers.invite2xxTimer);
            this.status = C.STATUS_CONFIRMED;
          }
          break;
        case SIP.C.INFO:
          contentType = request.getHeader('content-type');
          if (contentType && (contentType.match(/^application\/dtmf-relay/i))) {
            new DTMF(this).init_incoming(request);
          }
          break;
        case SIP.C.REFER:
          this.logger.log('REFER received');
          request.reply(202, 'Accepted');
          
          this.sendRequest(SIP.C.NOTIFY,
            {
              extraHeaders: [
                'Event: refer',
                'Subscription-State: terminated',
                'Content-Type: message/sipfrag'
              ],
              body: 'SIP/2.0 100 Trying'
            });

          // HACK: Stop localMedia so Chrome doesn't get confused about gUM
          if (this.rtcMediaHandler && this.rtcMediaHandler.localMedia) {
            this.rtcMediaHandler.localMedia.stop();
          }

          /*
            Harmless race condition.  Both sides of REFER
            may send a BYE, but in the end the dialogs are destroyed.
          */
          referSession = this.ua.invite(request.parseHeader('refer-to').uri, {
            media: this.mediaHint
          });

          this.referred(request, referSession);

          this.terminate();
          break;
      }
    }
  }
};

SIP.InviteClientContext = InviteClientContext;

}(SIP));
