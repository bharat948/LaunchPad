import { EmptyTicketTypesError, InvalidStateTransitionError } from '../../../shared/domain/DomainError.js';
import { EventStatus } from './EventStatus.js';
import { Money } from './Money.js';
import { TicketType } from './TicketType.js';
import { TimeWindow } from './TimeWindow.js';

export class Event {
  public readonly id: string;
  public readonly organizerId: string;
  public title: string;
  public saleWindow: TimeWindow;
  private _status: EventStatus;
  private _ticketTypes: Map<string, TicketType>;

  private constructor(id: string, organizerId: string, title: string, saleWindow: TimeWindow, status: EventStatus = EventStatus.DRAFT) {
    if (!id || id.trim().length === 0) throw new Error('Event ID cannot be empty');
    if (!organizerId || organizerId.trim().length === 0) throw new Error('Organizer ID cannot be empty');
    if (!title || title.trim().length === 0) throw new Error('Event title cannot be empty');

    this.id = id;
    this.organizerId = organizerId;
    this.title = title.trim();
    this.saleWindow = saleWindow;
    this._status = status;
    this._ticketTypes = new Map<string, TicketType>();
  }

  public static create(id: string, organizerId: string, title: string, saleWindow: TimeWindow): Event {
    return new Event(id, organizerId, title, saleWindow, EventStatus.DRAFT);
  }

  public get status(): EventStatus {
    return this._status;
  }

  public get ticketTypes(): ReadonlyArray<TicketType> {
    return Array.from(this._ticketTypes.values());
  }

  public addTicketType(ticketTypeId: string, name: string, price: Money, capacity: number): TicketType {
    if (this._status !== EventStatus.DRAFT) {
      throw new Error(`Cannot add ticket type to event when status is ${this._status}`);
    }
    const ticketType = new TicketType(ticketTypeId, this.id, name, price, capacity);
    this._ticketTypes.set(ticketTypeId, ticketType);
    return ticketType;
  }

  public schedule(): void {
    if (this._status !== EventStatus.DRAFT) {
      throw new InvalidStateTransitionError(this._status, EventStatus.SCHEDULED);
    }
    if (this._ticketTypes.size === 0) {
      throw new EmptyTicketTypesError();
    }
    this._status = EventStatus.SCHEDULED;
  }

  public publish(): void {
    if (this._status !== EventStatus.DRAFT && this._status !== EventStatus.SCHEDULED) {
      throw new InvalidStateTransitionError(this._status, EventStatus.LIVE);
    }
    if (this._ticketTypes.size === 0) {
      throw new EmptyTicketTypesError();
    }
    this._status = EventStatus.LIVE;
  }

  public cancel(): void {
    if (this._status === EventStatus.CANCELLED || this._status === EventStatus.ENDED) {
      throw new InvalidStateTransitionError(this._status, EventStatus.CANCELLED);
    }
    this._status = EventStatus.CANCELLED;
  }
}
