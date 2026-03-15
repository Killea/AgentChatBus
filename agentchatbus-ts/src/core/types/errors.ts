export class BusError extends Error {
  constructor(public message: string, public detail?: any) {
    super(message);
    this.name = "BusError";
    Object.setPrototypeOf(this, BusError.prototype);
  }
}

export class MissingSyncFieldsError extends BusError {
  constructor(missingFields: string[]) {
    super(`Missing required sync fields: ${missingFields.join(', ')}`);
    this.name = "MissingSyncFieldsError";
    Object.setPrototypeOf(this, MissingSyncFieldsError.prototype);
  }
}

export class SeqMismatchError extends BusError {
  constructor(
    public expected_last_seq: number,
    public current_seq: number,
    public new_messages: any[]
  ) {
    super(`SEQ_MISMATCH: expected_last_seq=${expected_last_seq}, current_seq=${current_seq}`);
    this.name = "SeqMismatchError";
    Object.setPrototypeOf(this, SeqMismatchError.prototype);
  }
}

export class ReplyTokenInvalidError extends BusError {
  constructor(public token?: string) {
    super("TOKEN_INVALID");
    this.name = "ReplyTokenInvalidError";
    Object.setPrototypeOf(this, ReplyTokenInvalidError.prototype);
  }
}

export class ReplyTokenExpiredError extends BusError {
  constructor(public token: string, public expires_at?: string) {
    super("TOKEN_EXPIRED");
    this.name = "ReplyTokenExpiredError";
    Object.setPrototypeOf(this, ReplyTokenExpiredError.prototype);
  }
}

export class ReplyTokenReplayError extends BusError {
  constructor(public token?: string, public consumed_at?: string) {
    super("TOKEN_REPLAY");
    this.name = "ReplyTokenReplayError";
    Object.setPrototypeOf(this, ReplyTokenReplayError.prototype);
  }
}

export class MessageNotFoundError extends BusError {
  constructor(messageId: string) {
    super("MESSAGE_NOT_FOUND", {
      error: "MESSAGE_NOT_FOUND",
      message_id: messageId
    });
    this.name = "MessageNotFoundError";
    Object.setPrototypeOf(this, MessageNotFoundError.prototype);
  }
}
