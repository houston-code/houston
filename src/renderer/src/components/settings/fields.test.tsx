import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadersField } from './fields'

afterEach(cleanup)

describe('HeadersField', () => {
  it('reports no change when the box is left as it was', () => {
    const onChange = vi.fn()
    const { rerender } = render(<HeadersField headers={undefined} onChange={onChange} label="Headers" />)
    const box = screen.getByRole('textbox', { name: 'Headers' })
    // Tabbing through an empty box is not an edit (it would store an empty map).
    fireEvent.focus(box)
    fireEvent.blur(box)
    // Nor is leaving stored (masked) values untouched.
    rerender(<HeadersField headers={{ Authorization: '' }} onChange={onChange} label="Headers" />)
    fireEvent.focus(box)
    fireEvent.blur(box)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports an edit when the field is left', () => {
    const onChange = vi.fn()
    render(<HeadersField headers={undefined} onChange={onChange} label="Headers" />)
    const box = screen.getByRole('textbox', { name: 'Headers' })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'X-Team: core' } })
    fireEvent.blur(box)
    expect(onChange).toHaveBeenCalledWith({ 'X-Team': 'core' })
  })
})
