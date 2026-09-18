// German texts of the invitation mail (all user-facing mail copy lives here, for later i18n).

export interface InviteMailInput {
  companyName: string | null;
  displayName: string;
  link: string;
  validDays: number;
}

export function inviteMail(i: InviteMailInput): { subject: string; text: string } {
  const company = i.companyName ?? 'Ihr Unternehmen';
  return {
    subject: `Einladung zu Lokyy Brain – ${company}`,
    text: [
      `Hallo ${i.displayName},`,
      '',
      `Sie wurden zu Lokyy Brain von ${company} eingeladen.`,
      '',
      'Über diesen Link legen Sie Ihr Passwort fest und melden sich an:',
      i.link,
      '',
      `Der Link ist ${i.validDays} Tage gültig und kann nur einmal verwendet werden.`,
      'Danach finden Sie unter „Mein Zugang“ den Link zu Ihrem Vault und die Zugangsdaten für KI-Werkzeuge.',
      '',
      'Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail einfach.',
    ].join('\n'),
  };
}
