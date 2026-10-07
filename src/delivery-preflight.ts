/** Certified by the fixed delivery callback before marking a network send attempt. */
export class DeliveryPreflightError extends Error {
 constructor(error:unknown){super(error instanceof Error?error.message:'Delivery preflight failed');this.name='DeliveryPreflightError';}
}
