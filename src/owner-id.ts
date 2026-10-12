/** Path-safe platform namespace. Numeric legacy owners remain unchanged. */
export function ownerId(value:unknown):value is string {return typeof value==='string'&&(/^[1-9][0-9]{0,19}$/.test(value)||/^discord-[1-9][0-9]{16,19}$/.test(value)&&BigInt(value.slice(8))<=18446744073709551615n);}
export function discordOwner(account:string):string{return 'discord-'+account;}
