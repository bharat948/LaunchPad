export interface TicketTypeDTO {
  id?: string;
  name: string;
  priceCents: number;
  currency?: string;
  capacity: number;
}

export interface CreateEventRequestDTO {
  organizerId: string;
  title: string;
  saleStartAt: string;
  saleEndAt: string;
  ticketTypes: TicketTypeDTO[];
}

export interface EventResponseDTO {
  id: string;
  organizerId: string;
  title: string;
  status: string;
  saleStartAt: string;
  saleEndAt: string;
  ticketTypes: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    capacity: number;
  }[];
}

export interface UpdateEventStatusRequestDTO {
  status: 'SCHEDULED' | 'LIVE' | 'CANCELLED';
}
