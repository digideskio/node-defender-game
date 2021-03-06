var _ = require('underscore');
var Async = require('async');
var config = require('../config/game');
var scoring = require('../config/scoring');
var MobRepo = require('../config/mobs');
var WaveFactory = require('./wave_factory');
var Util = require('./util');

var Game = (function() {

	var onLastWaveEnemy;
	var _mobTypes = _.keys(MobRepo);

	var _waveInterval = config.waveInterval; // Wave trigger round mod

	var getTopCategory = function(category, callback) {
		var sorter = {};
		sorter[category] = -1;
		this.collection('results').aggregate([
			{ $sort: sorter },
			{ $project: {
				_id: 0,
				name: 1,
				image: '$profile.profile_image_url_https',
				category_value: '$' + category
			}},
			{ $limit: 1 },

		], function(err, result) {
			callback(err, result);
		});
	};

	function Game(player) {
		this.waveTimer = 1;
		this.round = 1;
		this.consumedTokens = [];
		this.waves = [];
		this.player = player;
		this.waveFactory = new WaveFactory();
		this.generateRoundToken();
	}

	Game.prototype.getRound = function() {
		return this.round;
	};

	Game.prototype.getRoundToken = function() {
		return this.roundToken;
	};

	Game.prototype.generateRoundToken = function() {
		this.roundToken = Util.randomToken();
	};

	Game.prototype.validateRoundToken = function(token) {
		return token === this.roundToken && !_.contains(this.consumedTokens, token);
	};

	Game.prototype.consumeRoundToken = function(token) {
		if (!this.validateRoundToken(token)) {
			return;
		}
		this.consumedTokens.push(token);
	};

	Game.prototype.setupRound = function() {
		var clear = this.waves.length === 0;
		if (clear || this.waveTimer % _waveInterval === 0) {
			if (clear) {
				this.player.waveCleared();
			}
			this.spawnEnemies();
			this.waveTimer = 0;
		}
		this.generateRoundToken();
		this.round++;
		this.waveTimer++;
	};

	Game.prototype.getEnemies = function() {
		var list = [];
		_.each(this.waves, function(enemyCollection){
			list.push(enemyCollection.list());
		});
		return _.flatten(list);
	};

	Game.prototype.spawnEnemies = function() {
		var wave = this.waveFactory.get(this.round);
		wave.onLastWaveEnemy(_.bind(onLastWaveEnemy, this));
		wave.onEnemyDeath(_.bind(this.player.handleKill, this.player));
		this.waves.push(wave);
	};

	/**
	 * Loops over the waves and collects information on enemy actions.
	 *
	 * Yields the player object to the enemies so that it can be inspected and/or attacked
	 * by the enemy objects.
	 *
	 * Stops processing if the player dies
	 *
	 * @param Player player
	 * @return Array
	 */
	Game.prototype.processEnemyActions = function(player){
		var waves, length, i, result;

		waves = this.waves;
		length = waves.length;
		result = [];
		for (i = 0; i <= length; i++){
			if (waves[i]){
				result.push.apply(result, waves[i].massAction(player));
			}
			if (player.isDead()){
				break;
			}
		}

		return result;
	};

	Game.prototype.getEnemyById = function(id) {
		var i, enemy, result;
		for (i = 0; i < this.waves.length; i++) {
			enemy = this.waves[i].byId(id);
			if (enemy) {
				result = {
					enemy : enemy,
					collection : this.waves[i]
				};
				break;
			}
		}
		return result;
	};

	Game.prototype.getRandomEnemy = function() {
		var rand = Math.random() * this.waves.length;
		return this.waves[rand].getRandom();
	};

	Game.prototype.summary = function() {
		var summary = [];
		_.each(this.waves, function(collection){
			summary.push({
				wave : collection._id,
				enemies : collection.summary()
			});
		});
		return summary;
	};

	Game.prototype.recordGame = function(db, callback) {
		var resultsCollection, data;
		if (!db) {
			callback('No Mongo connection available.', this);
			return;
		}
		resultsCollection = db.collection('results');
		data = _.extend(
			{round: this.round},
			this.player.info(),
			{score: this.calculateScore()});
		resultsCollection.insert(data, _.bind(function(err) {
			callback(err, this);
		}, this));
	};

	Game.prototype.calculateScore = function() {
		return this.player.kills() * scoring.kill +
			this.player.effectiveDamage() * scoring.damage +
			this.round * scoring.round +
			this.player.wavesCleared() * scoring.waveCleared;
	};

	/**
	 * Retrieve the (up to) top 10 scores.
	 *
	 * @param MongoClient db
	 * @param function callback
	 * @return void
	 */
	Game.topScoreList = function(db, callback) {
		if (!db) {
			callback('DB not available.');
			return;
		}
		db.collection('results').aggregate([
			{ $sort: {score: -1} },
			{ $group: { _id: '$name', profile: { $first: '$profile' }, score: { $first: '$score' } } },
			{ $sort: {score: -1}}, {$limit: 10}
		], function(err, result) {
			var results = [];
			if (err) {
				callback(err, []);
			}
			_.each(result, function(entry) {
				entry.profile = entry.profile || {};
				results.push({
					username: entry._id,
					image: !!entry.profile.profile_image_url_https ?
						entry.profile.profile_image_url_https :
						null,
					score: entry.score,
				});
			});
			callback(null, results);
		});
	};

	/**
	 * Retrieve the top categories (kills, damage, round, etc).
	 *
	 * @param  MongoClient db
	 * @param  function callback
	 * @return void
	 */
	Game.topCategoryList = function(db, callback) {
		var map = ['kills', 'damage', 'round', 'waveClears'],
			list = {};
		if (!db) {
			callback('DB not available.');
			return;
		}

		Async.map(['kills', 'damage', 'round', 'waveClears'], _.bind(getTopCategory, db), function(err, results) {
			if (err) {
				callback(err);
				return;
			}
			_.each(results, function(result, index) {
				list[map[index]] = result[0];
			});
			callback(null, list);
		});
	};

	/**
	 * Listener for when the last enemy is removed from a wave's enemy collection.
	 *
	 * @access private
	 * @param EnemyCollection collection
	 * @return void
	 */
	onLastWaveEnemy = function(collection) {
		this.waves = _.reject(this.waves, function (wave) {
			return wave._id === collection._id;
		});
	};

	return Game;

}());

module.exports = Game;
