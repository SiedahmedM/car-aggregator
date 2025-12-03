# 📚 Saifnesse Database Documentation

> **The Complete Reference for Understanding Every Table, Column, and Value**

This folder contains the complete documentation for the Saifnesse database architecture. Whether you're a new employee, a returning founder, or debugging at 3 AM, these docs will guide you.

---

## 🗂️ Documentation Structure

### Quick Start
- **[01_OVERVIEW.md](./01_OVERVIEW.md)** - Start here. Understand the mission and data flow.

### Layer-by-Layer Deep Dives
- **[02_CORE_DATA_LAYER.md](./02_CORE_DATA_LAYER.md)** - The raw assets (`listings`, `raw_html`)
- **[03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md)** - The robots (`sources`, `offerup_jobs`, etc.)
- **[04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md)** - The brains (old `deal_scores` + new `arbitrage_valuations`)
- **[05_USER_ACTION_LAYER.md](./05_USER_ACTION_LAYER.md)** - User interactions (`saved_deals`, `dismissed_deals`, `flipped_cars`)

### Reference
- **[06_COMPLETE_SCHEMA_REFERENCE.md](./06_COMPLETE_SCHEMA_REFERENCE.md)** - Alphabetical table of all tables and columns

---

## 🎯 The Three Stages of Saifnesse

Our database evolves through three industrial phases:

### **Stage 1: The Wedge (Now)** 🚗
- **Focus**: Vehicle Arbitrage (Private-to-Wholesale)
- **Tables in Use**: `listings`, `sources`, `offerup_jobs`, `arbitrage_valuations`
- **Goal**: Dominate car deal-finding with high velocity, low complexity

### **Stage 2: The Verification (Next)** 🔍
- **Focus**: "Ghost Buyer" Infrastructure (Trust as a Service)
- **Future Tables**: `verification_requests`, `inspector_network`, `condition_reports`
- **Goal**: Enable remote inspection and validation at scale

### **Stage 3: The Universal Ledger (Future)** 🌍
- **Focus**: Automated Market Making for All Assets
- **Future Expansion**: Real Estate, Heavy Equipment, Contracts
- **Goal**: The Bloomberg Terminal for All Arbitrage

---

## 🔍 Quick Lookup

**Looking for a specific table?** → [06_COMPLETE_SCHEMA_REFERENCE.md](./06_COMPLETE_SCHEMA_REFERENCE.md)

**Need to understand data flow?** → [01_OVERVIEW.md](./01_OVERVIEW.md)

**Debugging a scraper?** → [03_INGESTION_LAYER.md](./03_INGESTION_LAYER.md)

**Building the new valuation engine?** → [04_INTELLIGENCE_LAYER.md](./04_INTELLIGENCE_LAYER.md)

---

## 💡 Philosophy

> "Most databases store **Data**. Saifnesse stores **Truth**."

This database is not just a collection of tables. It's a system designed to:
1. **Ingest Chaos** (scraped listings from the internet)
2. **Extract Signal** (calculate profit, liquidity, distress)
3. **Surface Opportunity** (show dealers where the money is hiding)

---

**Last Updated**: 2025-11-30
