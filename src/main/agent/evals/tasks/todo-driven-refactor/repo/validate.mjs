export function validate(user) {
  if (!user.name) return 'name required'
  return null
}
