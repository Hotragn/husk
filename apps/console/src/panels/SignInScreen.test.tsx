import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SignInScreen } from './SignInScreen';

const signIn = vi.fn(async () => {});
let signInError: string | null = null;
vi.mock('../state/connection', () => ({ useConnection: () => ({ signIn, signInError }) }));

describe('the sign-in screen', () => {
  afterEach(() => {
    cleanup();
    signIn.mockClear();
    signInError = null;
  });

  it('points to husk console, and signs in with what is pasted', () => {
    render(<SignInScreen />);
    expect(screen.getByText('husk console')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Or paste a sign-in code'), { target: { value: ' c0de ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith(' c0de ');
  });

  it('says why the last try did not sign in', () => {
    signInError = 'That sign-in link was already used, or has expired. Run `husk console` for a new one.';
    render(<SignInScreen />);
    expect(screen.getByRole('alert').textContent).toContain('already used');
  });
});
