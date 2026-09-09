import { UsageSeries } from "../types/adminStats.type";
import api from "./api.service";

const getUsage = async (months: number): Promise<UsageSeries> => {
  return (await api.get("/admin/stats/usage", { params: { months } })).data;
};

export default { getUsage };
