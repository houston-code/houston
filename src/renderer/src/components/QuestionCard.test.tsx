import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QUESTION_EMPTY_ANSWER, QUESTION_STOPPED_ANSWER } from '@shared/promptOutcome'
import type { QuestionItem } from '../lib/items'
import { QuestionCard } from './QuestionCard'

const question = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  kind: 'question',
  id: 'q1',
  question: 'Which database should I use?',
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  ...over
})

describe('QuestionCard', () => {
  it('answers with the clicked option', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard item={question()} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByText('SQLite'))
    expect(onAnswer).toHaveBeenCalledWith('q1', 'SQLite')
  })

  it('records a real answer under "Answered"', () => {
    render(<QuestionCard item={question({ answer: 'Postgres' })} onAnswer={vi.fn()} />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('Postgres')).toBeInTheDocument()
  })

  // Stopping the run answers the model with a bracketed note; it is not the user's answer.
  it('shows a question the run was stopped in front of as not answered', () => {
    render(<QuestionCard item={question({ answer: QUESTION_STOPPED_ANSWER })} onAnswer={vi.fn()} />)
    expect(screen.getByText('Not answered')).toBeInTheDocument()
    expect(screen.getByText('The run was stopped before you answered.')).toBeInTheDocument()
    expect(screen.queryByText('Answered')).not.toBeInTheDocument()
    expect(screen.queryByText(QUESTION_STOPPED_ANSWER)).not.toBeInTheDocument()
  })

  it('shows an empty reply as not answered', () => {
    render(<QuestionCard item={question({ answer: QUESTION_EMPTY_ANSWER })} onAnswer={vi.fn()} />)
    expect(screen.getByText('Not answered')).toBeInTheDocument()
    expect(screen.getByText('No answer was given.')).toBeInTheDocument()
  })
})
