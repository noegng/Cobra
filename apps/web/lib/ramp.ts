/**
 * Ripio public on-ramp ("Pagar en pesos" / "Pagar em reais").
 *
 * Ripio's public ramp needs NO partner account (https://ramp.ripio.com/llms.txt; AR/CO/MX/BR). Its URL query
 * params are not documented, so the link is the bare page and the payer is given copy-paste instructions
 * (amount, token, network Celo, address) next to it.
 */
export const RIPIO_ONRAMP_URL = "https://ramp.ripio.com/";

/** Single builder for the payer-side link. */
export function buildRipioOnrampUrl(): string {
  return RIPIO_ONRAMP_URL;
}
