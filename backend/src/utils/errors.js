class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function badRequest(message) {
  throw new HttpError(400, message);
}

module.exports = { HttpError, badRequest };
