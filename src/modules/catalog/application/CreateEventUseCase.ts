import { randomUUID } from 'crypto';
import { Event } from '../domain/Event.js';
import { TimeWindow } from '../domain/TimeWindow.js';
import { Money } from '../domain/Money.js';
import { InventoryPool } from '../../inventory/domain/InventoryPool.js';
import { IEventRepository } from '../infrastructure/PostgresEventRepository.js';
import { CreateEventRequestDTO, EventResponseDTO } from './EventDTOs.js';

export class CreateEventUseCase {
  constructor(private eventRepo: IEventRepository) {}

  public async execute(dto: CreateEventRequestDTO): Promise<EventResponseDTO> {
    const eventId = randomUUID();
    const saleWindow = new TimeWindow(new Date(dto.saleStartAt), new Date(dto.saleEndAt));
    const event = Event.create(eventId, dto.organizerId, dto.title, saleWindow);

    const inventoryPools: InventoryPool[] = [];

    if (Array.isArray(dto.ticketTypes)) {
      for (const ttDto of dto.ticketTypes) {
        const ttId = ttDto.id || randomUUID();
        const price = new Money(ttDto.priceCents, ttDto.currency || 'USD');
        event.addTicketType(ttId, ttDto.name, price, ttDto.capacity);
        
        // Create matching inventory pool
        inventoryPools.push(new InventoryPool(ttId, ttDto.capacity));
      }
    }

    await this.eventRepo.save(event, inventoryPools);

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
