export class NotFoundError extends Error {
  constructor(id) {
    super(`no note with id ${id}`)
    this.name = 'NotFoundError'
    this.code = 'NOTE_NOT_FOUND'
    this.id = id
  }
}
