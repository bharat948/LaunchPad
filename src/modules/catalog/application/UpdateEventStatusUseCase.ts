import { EventStatus } from '../domain/EventStatus.js';
import { IEventRepository } from '../infrastructure/PostgresEventRepository.js';
import { EventResponseDTO } from './EventDTOs.js';

export class UpdateEventStatusUseCase {
  constructor(private eventRepo: IEventRepository) {}

  public async execute(id: string, targetStatus: string): Promise<EventResponseDTO | null> {
    const event = await this.eventRepo.findById(id);
    if (!event) return null;

    if (event.status === targetStatus) {
      // Idempotent: return current state without error
      return this.toDTO(event);
    }

    switch (targetStatus) {
      case EventStatus.SCHEDULED:
        event.schedule();
        break;
      case EventStatus.LIVE:
        event.publish();
        break;
      case EventStatus.CANCELLED:
        event.cancel();
        break;
      default:
        throw new Error(`Invalid status transition target: ${targetStatus}`);
    }

    await this.eventRepo.updateStatus(event);
    return this.toDTO(event);
  }

  private toDTO(event: any): EventResponseDTO {
    return {
      id: event.id,
      organizerId: event.organizerId,
      title: event.title,
      status: event.status,
      saleStartAt: event.saleWindow.startAt.toISOString(),
      saleEndAt: event.saleWindow.endAt.toISOString(),
      ticketTypes: event.ticketTypes.map((tt: any) => ({
        id: tt.id,
        name: tt.name,
        priceCents: tt.price.amountCents,
        currency: tt.price.currency,
        capacity: tt.capacity,
      })),
    };
  }
}
