import { promises as fs } from 'fs';
import path from 'path';

// Оновлений інтерфейс для роботи зі зв'язкою "користувач -> його вулиці"
export interface IStorage {
    load(): Promise<void>;
    save(): Promise<void>;

    // Повністю видаляє користувача і всі його дані
    removeSubscriber(chatId: number): Promise<void>;

    // Методи для керування вулицями конкретного користувача
    addStreet(chatId: number, street: string): Promise<void>;
    removeStreet(chatId: number, street: string): Promise<boolean>; // Повертає true, якщо вулиця була і її видалили
    getStreetsFor(chatId: number): Promise<string[]>;

    // Метод для отримання всіх даних для обробки сповіщень
    getAllSubscriptions(): Promise<Map<number, Set<string>>>;
}

export class JsonFileStorage implements IStorage {
    // Нова структура даних: Map<chatId, Set<вулиці>>
    private subscriptions: Map<number, Set<string>> = new Map();
    private readonly filePath: string;

    constructor(fileName: string = 'bot_subscriptions.json') {
        this.filePath = path.resolve(process.cwd(), fileName);
        console.log(`Файл сховища: ${this.filePath}`);
    }

    async load(): Promise<void> {
        try {
            await fs.access(this.filePath);
            const data = await fs.readFile(this.filePath, 'utf-8');
            // Десеріалізація Map зі збереженого масиву [key, value] пар
            const parsedData: [number, string[]][] = JSON.parse(data);
            this.subscriptions = new Map(parsedData.map(([chatId, streets]) => [chatId, new Set(streets)]));
            console.log(`Завантажено підписки для ${this.subscriptions.size} користувачів.`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log('Файл підписок не знайдено, буде створено новий.');
                this.subscriptions = new Map();
            } else {
                console.error('Не вдалося завантажити дані підписок:', error);
            }
        }
    }

    async save(): Promise<void> {
        try {
            // Серіалізація Map в масив [key, value] пар для коректного збереження в JSON
            const dataToSave = Array.from(this.subscriptions.entries()).map(([chatId, streetsSet]) => [chatId, Array.from(streetsSet)]);
            const data = JSON.stringify(dataToSave, null, 2); // форматування для читабельності
            await fs.writeFile(this.filePath, data, 'utf-8');
            console.log(`Збережено підписки для ${this.subscriptions.size} користувачів.`);
        } catch (error) {
            console.error('Не вдалося зберегти дані підписок:', error);
        }
    }

    async removeSubscriber(chatId: number): Promise<void> {
        this.subscriptions.delete(chatId);
    }

    async addStreet(chatId: number, street: string): Promise<void> {
        // Якщо користувача ще немає, створюємо для нього новий Set
        if (!this.subscriptions.has(chatId)) {
            this.subscriptions.set(chatId, new Set());
        }
        // Додаємо вулицю. `toLowerCase()` для уніфікації
        this.subscriptions.get(chatId)?.add(street.toLowerCase());
    }

    async removeStreet(chatId: number, street: string): Promise<boolean> {
        const streets = this.subscriptions.get(chatId);
        if (streets) {
            return streets.delete(street.toLowerCase());
        }
        return false;
    }

    async getStreetsFor(chatId: number): Promise<string[]> {
        const streets = this.subscriptions.get(chatId);
        return streets ? Array.from(streets) : [];
    }

    async getAllSubscriptions(): Promise<Map<number, Set<string>>> {
        return this.subscriptions;
    }
}