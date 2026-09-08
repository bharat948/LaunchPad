import { IEventRepository } from '../infrastructure/PostgresEventRepository.js';
import { EventResponseDTO } from './EventDTOs.js';

export class GetEventByIdUseCase {
  constructor(private eventRepo: IEventRepository) {}

  public async execute(id: string): Promise<EventResponseDTO | null> {
    const event = await this.eventRepo.findById(id);
    if (!event) return null;

    return {
      id: event.id,
      organizerId: event.organizerId,
      title: event.title,
      status: event.status,
      saleStartAt: event.saleWindow.startAt.toISOString(),
      saleEndAt: event.saleWindow.endAt.toISOString(),
      ticketTypes: event.ticketTypes.map(tt => ({
        id: tt.id,
        name: tt.name,
        priceCents: tt.price.amountCents,
        currency: tt.price.currency,
        capacity: tt.capacity,
      })),
    };
  }
}
