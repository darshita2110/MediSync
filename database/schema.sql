-- CREATE TABLE users (
--     user_id SERIAL PRIMARY KEY,
--     full_name VARCHAR(100) NOT NULL,
--     age INT,
--     gender VARCHAR(10),
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- CREATE TABLE medications (
-- 	med_id SERIAL PRIMARY KEY,
-- 	user_id INT REFERENCES users(user_id) ON DELETE CASCADE, 
-- 	name VARCHAR(255) NOT NULL,
-- 	dosgae varchar(50),
-- 	frequency varchar(100),
-- 	total_stock int,
-- 	remaining_pills int
-- );

-- Create table reminders (
-- 	reminder_id serial primary key,
-- 	med_id int references medications(med_id) on delete cascade,
-- 	reminder_time time not null,
-- 	is_taken boolean default false,
-- 	last_taken_date Date
-- );

insert into users values(1, 'Darshita', 2)